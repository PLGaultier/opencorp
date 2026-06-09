import {
  pgTable,
  pgEnum,
  text,
  uuid,
  integer,
  bigint,
  boolean,
  numeric,
  timestamp,
  jsonb,
  bigserial,
  customType,
  index,
  vector,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

// ── Enums ──────────────────────────────────────────────────────────────────
export const companyStatus = pgEnum("company_status", ["active", "paused"]);
export const autonomyLevel = pgEnum("autonomy_level", ["supervised", "bounded", "full"]);
export const agentKind = pgEnum("agent_kind", ["ceo", "worker"]);
export const modelTier = pgEnum("model_tier", ["frontier", "standard", "mini"]);
export const taskStatus = pgEnum("task_status", [
  "pending",
  "queued",
  "running",
  "failed",
  "done",
  "deleted",
]);
export const creditReason = pgEnum("credit_reason", [
  "grant",
  "task_charge",
  "task_refund",
  "referral",
  "adjustment",
]);
export const emailDirection = pgEnum("email_direction", ["in", "out"]);
export const membershipRole = pgEnum("membership_role", ["owner", "admin", "member"]);
export const withdrawalStatus = pgEnum("withdrawal_status", [
  "pending",
  "processing",
  "paid",
  "failed",
]);

// ── Tenancy ────────────────────────────────────────────────────────────────
export const conglomerates = pgTable("conglomerates", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: text("owner_user_id").notNull(),
  name: text("name").notNull(),
  dailyCreditCap: numeric("daily_credit_cap").notNull().default("10"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable("memberships", {
  userId: text("user_id").notNull(),
  conglomerateId: uuid("conglomerate_id")
    .notNull()
    .references(() => conglomerates.id),
  role: membershipRole("role").notNull().default("member"),
});

// ── Companies ──────────────────────────────────────────────────────────────
export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  conglomerateId: uuid("conglomerate_id")
    .notNull()
    .references(() => conglomerates.id),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  mission: text("mission").notNull(),
  status: companyStatus("status").notNull().default("active"),
  dailyTaskCap: integer("daily_task_cap").notNull().default(3),
  subdomain: text("subdomain"),
  customDomain: text("custom_domain"),
  emailAddress: text("email_address"),
  dbName: text("db_name"),
  forgejoRepo: text("forgejo_repo"),
  umamiSiteId: text("umami_site_id"),
  realBalanceCents: bigint("real_balance_cents", { mode: "number" }).notNull().default(0),
  autonomyLevel: autonomyLevel("autonomy_level").notNull().default("supervised"),
  isPublic: boolean("is_public").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Agents ─────────────────────────────────────────────────────────────────
export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  kind: agentKind("kind").notNull(),
  name: text("name").notNull(),
  rolePrompt: text("role_prompt").notNull(),
  modelTier: modelTier("model_tier").notNull().default("standard"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Tasks ──────────────────────────────────────────────────────────────────
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: taskStatus("status").notNull().default("pending"),
    priority: integer("priority").notNull().default(0),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    creditsEstimated: numeric("credits_estimated"),
    creditsCharged: numeric("credits_charged"),
    temporalWorkflowId: text("temporal_workflow_id"),
    resultSummary: text("result_summary"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("tasks_company_status_idx").on(t.companyId, t.status, t.priority)],
);

// ── Credits: double-entry, immutable ───────────────────────────────────────
export const creditEntries = pgTable(
  "credit_entries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    conglomerateId: uuid("conglomerate_id")
      .notNull()
      .references(() => conglomerates.id),
    companyId: uuid("company_id").references(() => companies.id),
    taskId: uuid("task_id").references(() => tasks.id),
    delta: numeric("delta").notNull(),
    reason: creditReason("reason").notNull(),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // covering index for the dispatch-time 24h cap check (§11.7)
  (t) => [index("credit_entries_cap_idx").on(t.conglomerateId, t.createdAt)],
);

// ── Transparency ledger: append-only hash chain (§9) ───────────────────────
export const ledgerEvents = pgTable(
  "ledger_events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    companyId: uuid("company_id"),
    actor: text("actor").notNull(), // 'ceo' | 'worker:{task}' | 'system' | 'user'
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(), // redacted before append (§9.3)
    prevHash: bytea("prev_hash").notNull(),
    hash: bytea("hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ledger_events_company_idx").on(t.companyId, t.seq)],
);

// ── Knowledge base / agent memory ──────────────────────────────────────────
export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  title: text("title").notNull(),
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: 1024 }),
  createdBy: text("created_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Email mirror (synced from Stalwart via JMAP) ───────────────────────────
export const emails = pgTable("emails", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  direction: emailDirection("direction").notNull(),
  fromAddr: text("from_addr").notNull(),
  toAddrs: text("to_addrs").array().notNull(),
  subject: text("subject").notNull().default(""),
  bodyText: text("body_text"),
  bodyHtml: text("body_html"),
  jmapId: text("jmap_id"),
  read: boolean("read").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Products & money ───────────────────────────────────────────────────────
export const products = pgTable("products", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  name: text("name").notNull(),
  priceCents: bigint("price_cents", { mode: "number" }).notNull(),
  currency: text("currency").notNull().default("eur"),
  providerRef: text("provider_ref"),
});

export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  productId: uuid("product_id").references(() => products.id),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  currency: text("currency").notNull(),
  providerRef: text("provider_ref"),
  feeCents: bigint("fee_cents", { mode: "number" }).notNull().default(0),
  netCents: bigint("net_cents", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const withdrawals = pgTable("withdrawals", {
  id: uuid("id").primaryKey().defaultRandom(),
  conglomerateId: uuid("conglomerate_id")
    .notNull()
    .references(() => conglomerates.id),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  providerTransferId: text("provider_transfer_id"),
  status: withdrawalStatus("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
