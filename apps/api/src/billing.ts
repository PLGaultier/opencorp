import type { Sql } from "postgres";

/**
 * Billing plans (§10). Credits are the source of truth and live in
 * credit_entries (reason 'grant'); Lago — when configured — mirrors the
 * subscription for invoicing, exactly like Stripe behind PaymentsProvider.
 * Without LAGO_URL the platform runs in `none` mode: plans still grant
 * credits, nothing is invoiced (pure self-hosting).
 *
 * Repo access is always free — plans gate credits only, never your own code.
 */

export type PlanId = "free" | "builder" | "pro";

export interface Plan {
  id: PlanId;
  name: string;
  priceCents: number; // monthly, EUR
  credits: number; // §10 pillar 1: monthly wallet allowance in CENTS, burned at real API cost
  oneTime: boolean;
}

// The allowance (cents) is worth less than the price — the gap is the
// subscription's gross margin; the platform's other pillar is the withdrawal fee.
export const PLANS: Record<PlanId, Plan> = {
  free: { id: "free", name: "Free", priceCents: 0, credits: 200, oneTime: true },
  builder: { id: "builder", name: "Builder", priceCents: 2900, credits: 2000, oneTime: false },
  pro: { id: "pro", name: "Pro", priceCents: 9900, credits: 8000, oneTime: false },
};

export interface SubscriptionRow {
  conglomerateId: string;
  plan: PlanId;
  status: "active" | "canceled";
  providerRef: string | null;
  currentPeriodStart: Date;
}

/** Storage seam so grant logic is testable without Postgres. */
export interface BillingStore {
  get(conglomerateId: string): Promise<SubscriptionRow | null>;
  upsert(row: SubscriptionRow): Promise<void>;
  /** Insert a credit grant; `period` is the idempotency key (in meta). */
  grant(conglomerateId: string, credits: number, meta: { plan: PlanId; period: string }): Promise<void>;
  hasGrant(conglomerateId: string, period: string): Promise<boolean>;
  listActive(): Promise<SubscriptionRow[]>;
}

/** External invoicing seam: Lago in prod, none for self-hosting. */
export interface BillingProvider {
  readonly kind: "lago" | "none";
  ensureSubscription(conglomerateId: string, plan: PlanId): Promise<string | null>;
}

export type LedgerAppend = (payload: Record<string, unknown>) => Promise<unknown>;

const periodKey = (plan: Plan, periodStart: Date): string =>
  plan.oneTime ? `${plan.id}:one-time` : `${plan.id}:${periodStart.toISOString().slice(0, 10)}`;

const addMonth = (d: Date): Date => {
  const next = new Date(d);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
};

/** Subscribe (or switch) a conglomerate to a plan; idempotent. */
export async function subscribe(
  store: BillingStore,
  provider: BillingProvider,
  appendLedger: LedgerAppend,
  conglomerateId: string,
  planId: PlanId,
  now: Date = new Date(),
): Promise<SubscriptionRow> {
  const plan = PLANS[planId];
  const existing = await store.get(conglomerateId);
  if (existing && existing.plan === planId && existing.status === "active") return existing;

  const providerRef = await provider.ensureSubscription(conglomerateId, planId);
  const row: SubscriptionRow = {
    conglomerateId,
    plan: planId,
    status: "active",
    providerRef,
    currentPeriodStart: now,
  };
  await store.upsert(row);

  const period = periodKey(plan, now);
  if (!(await store.hasGrant(conglomerateId, period))) {
    await store.grant(conglomerateId, plan.credits, { plan: planId, period });
    await appendLedger({ conglomerateId, plan: planId, delta: plan.credits, reason: "grant", period });
  }
  return row;
}

/**
 * Advance all active recurring subscriptions whose cycle has elapsed and
 * grant the new period's credits. Safe to call from a cron at any frequency;
 * grants are keyed by period so retries and overlapping runs are no-ops.
 */
export async function runGrantCycle(
  store: BillingStore,
  appendLedger: LedgerAppend,
  now: Date = new Date(),
): Promise<{ granted: number }> {
  let granted = 0;
  for (const sub of await store.listActive()) {
    const plan = PLANS[sub.plan];
    if (plan.oneTime) continue;
    let periodStart = sub.currentPeriodStart;
    while (addMonth(periodStart) <= now) {
      periodStart = addMonth(periodStart);
      const period = periodKey(plan, periodStart);
      if (await store.hasGrant(sub.conglomerateId, period)) continue;
      await store.grant(sub.conglomerateId, plan.credits, { plan: plan.id, period });
      await appendLedger({
        conglomerateId: sub.conglomerateId,
        plan: plan.id,
        delta: plan.credits,
        reason: "grant",
        period,
      });
      granted++;
    }
    if (periodStart > sub.currentPeriodStart) {
      await store.upsert({ ...sub, currentPeriodStart: periodStart });
    }
  }
  return { granted };
}

// ── Postgres store ─────────────────────────────────────────────────────────
export class PgBillingStore implements BillingStore {
  constructor(private sql: Sql) {}

  async get(conglomerateId: string): Promise<SubscriptionRow | null> {
    const [r] = await this.sql<
      { conglomerate_id: string; plan: PlanId; status: "active" | "canceled"; provider_ref: string | null; current_period_start: Date }[]
    >`SELECT conglomerate_id, plan, status, provider_ref, current_period_start
      FROM subscriptions WHERE conglomerate_id = ${conglomerateId}`;
    return r ? this.toRow(r) : null;
  }

  async upsert(row: SubscriptionRow): Promise<void> {
    await this.sql`
      INSERT INTO subscriptions (conglomerate_id, plan, status, provider_ref, current_period_start)
      VALUES (${row.conglomerateId}, ${row.plan}, ${row.status}, ${row.providerRef}, ${row.currentPeriodStart})
      ON CONFLICT (conglomerate_id) DO UPDATE SET
        plan = EXCLUDED.plan, status = EXCLUDED.status,
        provider_ref = EXCLUDED.provider_ref, current_period_start = EXCLUDED.current_period_start`;
  }

  async grant(conglomerateId: string, credits: number, meta: { plan: PlanId; period: string }): Promise<void> {
    await this.sql`
      INSERT INTO credit_entries (conglomerate_id, delta, reason, meta)
      VALUES (${conglomerateId}, ${credits}, 'grant', ${this.sql.json(meta)})`;
  }

  async hasGrant(conglomerateId: string, period: string): Promise<boolean> {
    const [r] = await this.sql`
      SELECT 1 FROM credit_entries
      WHERE conglomerate_id = ${conglomerateId} AND reason = 'grant' AND meta->>'period' = ${period}`;
    return Boolean(r);
  }

  async listActive(): Promise<SubscriptionRow[]> {
    const rows = await this.sql<
      { conglomerate_id: string; plan: PlanId; status: "active" | "canceled"; provider_ref: string | null; current_period_start: Date }[]
    >`SELECT conglomerate_id, plan, status, provider_ref, current_period_start
      FROM subscriptions WHERE status = 'active'`;
    return rows.map((r) => this.toRow(r));
  }

  private toRow(r: { conglomerate_id: string; plan: PlanId; status: "active" | "canceled"; provider_ref: string | null; current_period_start: Date }): SubscriptionRow {
    return {
      conglomerateId: r.conglomerate_id,
      plan: r.plan,
      status: r.status,
      providerRef: r.provider_ref,
      currentPeriodStart: new Date(r.current_period_start),
    };
  }
}

// ── In-memory store (tests / ephemeral dev) ────────────────────────────────
export class MemoryBillingStore implements BillingStore {
  private subs = new Map<string, SubscriptionRow>();
  readonly grants: { conglomerateId: string; credits: number; meta: { plan: PlanId; period: string } }[] = [];

  async get(id: string) {
    return this.subs.get(id) ?? null;
  }
  async upsert(row: SubscriptionRow) {
    this.subs.set(row.conglomerateId, { ...row });
  }
  async grant(conglomerateId: string, credits: number, meta: { plan: PlanId; period: string }) {
    this.grants.push({ conglomerateId, credits, meta });
  }
  async hasGrant(conglomerateId: string, period: string) {
    return this.grants.some((g) => g.conglomerateId === conglomerateId && g.meta.period === period);
  }
  async listActive() {
    return [...this.subs.values()].filter((s) => s.status === "active");
  }
}

// ── Providers ──────────────────────────────────────────────────────────────
class NoneBilling implements BillingProvider {
  readonly kind = "none";
  async ensureSubscription(): Promise<null> {
    return null;
  }
}

class LagoBilling implements BillingProvider {
  readonly kind = "lago";
  constructor(
    private url: string,
    private apiKey: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async ensureSubscription(conglomerateId: string, plan: PlanId): Promise<string> {
    // Lago upserts customers by external_id; an existing subscription is a 422
    // we treat as success (idempotent under Temporal/HTTP retries).
    await this.call("customers", { customer: { external_id: conglomerateId } });
    const externalId = `sub_${conglomerateId}_${plan}`;
    await this.call(
      "subscriptions",
      { subscription: { external_customer_id: conglomerateId, plan_code: plan, external_id: externalId } },
      [422],
    );
    return externalId;
  }

  private async call(path: string, body: unknown, okErrors: number[] = []): Promise<void> {
    const res = await this.fetchFn(`${this.url.replace(/\/$/, "")}/api/v1/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok && !okErrors.includes(res.status)) {
      throw new Error(`lago ${path} failed: ${res.status} ${await res.text()}`);
    }
  }
}

export function billingProviderFromEnv(): BillingProvider {
  const url = process.env.LAGO_URL;
  const key = process.env.LAGO_API_KEY;
  return url && key ? new LagoBilling(url, key) : new NoneBilling();
}
