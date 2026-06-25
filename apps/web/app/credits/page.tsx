"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { API_URL } from "@/lib/data";
import { useSession } from "@/lib/auth-client";

interface CreditEntry {
  id: string;
  delta: number;
  reason: string;
  companyId: string | null;
  companyName: string | null;
  taskId: string | null;
  createdAt: string;
}

interface CreditData {
  conglomerateId: string;
  balance: number; // cents — real money, burned at real API cost (§10 pillar 1)
  burnCentsPerDay: number;
  runwayDays: number | null;
  breakdown: Record<string, number>;
  connectAccountId: string | null;
  subscription: { plan: string; status: string; currentPeriodStart: string | null } | null;
  entries: CreditEntry[];
}

interface Plan {
  id: string;
  name: string;
  priceCents: number;
  credits: number;
  oneTime: boolean;
}

const REASON_LABELS: Record<string, string> = {
  grant: "Granted",
  task_charge: "Task charges",
  task_refund: "Task refunds",
  referral: "Referral bonus",
  adjustment: "Adjustments",
  revenue_reinvest: "Self-financed (revenue)",
};

const dt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });

const eur = (cents: number) => `€${(cents / 100).toFixed(2)}`;

export default function CreditsPage() {
  const { data: session, isPending } = useSession();
  const [data, setData] = useState<CreditData | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [subscribing, setSubscribing] = useState<string | null>(null);
  const [subError, setSubError] = useState<string | null>(null);
  const [subDone, setSubDone] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectMsg, setConnectMsg] = useState<string | null>(null);
  const [toppingUp, setToppingUp] = useState<number | null>(null);

  useEffect(() => {
    if (!API_URL || isPending || !session) { setLoading(false); return; }
    const load = async () => {
      try {
        // get conglomerate id from /api/me then fetch credits
        const me = await fetch(`${API_URL}/api/me`, { credentials: "include" });
        if (!me.ok) { setLoading(false); return; }
        const { conglomerateIds } = (await me.json()) as { conglomerateIds: string[] };
        const conglomerateId = conglomerateIds[0];
        if (!conglomerateId) { setLoading(false); return; }

        const [credRes, planRes] = await Promise.all([
          fetch(`${API_URL}/api/conglomerates/${conglomerateId}/credits`, { credentials: "include" }),
          fetch(`${API_URL}/api/plans`),
        ]);
        if (credRes.ok) setData(await credRes.json() as CreditData);
        if (planRes.ok) {
          const { plans: p } = (await planRes.json()) as { plans: Plan[] };
          setPlans(p);
        }
      } catch { /* network error — show empty state */ }
      setLoading(false);
    };
    void load();
  }, [session, isPending]);

  const subscribeTo = async (planId: string) => {
    if (!data) return;
    setSubscribing(planId);
    setSubError(null);
    try {
      const res = await fetch(`${API_URL}/conglomerates/${data.conglomerateId}/subscribe`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan: planId }),
      });
      const d = (await res.json()) as { error?: string; checkoutUrl?: string };
      if (!res.ok) {
        setSubError(d.error ?? "subscription failed");
      } else if (d.checkoutUrl) {
        window.location.href = d.checkoutUrl; // Stripe Checkout (paid plan)
        return;
      } else {
        setSubDone(planId);
        // reload credit data (local mode grants immediately)
        const credRes = await fetch(`${API_URL}/api/conglomerates/${data.conglomerateId}/credits`, { credentials: "include" });
        if (credRes.ok) setData(await credRes.json() as CreditData);
      }
    } catch {
      setSubError("API unreachable");
    }
    setSubscribing(null);
  };

  const topUp = async (amountCents: number) => {
    if (!data) return;
    setToppingUp(amountCents);
    try {
      const res = await fetch(`${API_URL}/api/conglomerates/${data.conglomerateId}/topup`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents }),
      });
      const d = (await res.json()) as { url?: string };
      if (d.url) window.location.href = d.url; // Stripe Checkout or local checkout page
      else setToppingUp(null);
    } catch {
      setToppingUp(null);
    }
  };

  const connectBank = async () => {
    if (!data) return;
    setConnecting(true);
    setConnectMsg(null);
    try {
      const res = await fetch(`${API_URL}/api/conglomerates/${data.conglomerateId}/connect/onboard`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        // Stripe sends the owner back here after finishing / to retry.
        body: JSON.stringify({ returnUrl: window.location.href }),
      });
      const d = (await res.json()) as {
        mode?: string;
        onboardingUrl?: string | null;
        message?: string;
        error?: string;
      };
      if (!res.ok) {
        setConnectMsg(d.message ?? d.error ?? "Couldn't start onboarding.");
      } else if (d.mode === "stripe" && d.onboardingUrl) {
        window.location.href = d.onboardingUrl; // hand off to Stripe-hosted KYC
      } else {
        // Local mode (no platform Stripe key) — Connect is off; payouts use the
        // local rail. Surface the gateway's explanation instead of redirecting.
        setConnectMsg(d.message ?? "Stripe Connect is not enabled on this instance.");
      }
    } catch {
      setConnectMsg("API unreachable");
    }
    setConnecting(false);
  };

  // ── Demo / unauthenticated states ──────────────────────────────────────────

  if (!API_URL) {
    return (
      <main>
        <h1>Credits</h1>
        <p className="sub">Demo preview — connect the dashboard to an API to see your credit balance.</p>
        <DemoCreditView />
      </main>
    );
  }

  if (!isPending && !session) {
    return (
      <main>
        <h1>Credits</h1>
        <p className="sub">
          Your credit balance and usage are only visible when signed in —{" "}
          <a href="/login" style={{ textDecoration: "underline" }}>sign in</a>.
        </p>
      </main>
    );
  }

  if (loading || isPending) {
    return (
      <main>
        <h1>Credits</h1>
        <p className="sub">Loading…</p>
      </main>
    );
  }

  if (!data) {
    return (
      <main>
        <h1>Credits</h1>
        <p className="sub">No conglomerate found. <a href="/new" style={{ textDecoration: "underline" }}>Found your first company</a> to create one.</p>
      </main>
    );
  }

  const currentPlan = data.subscription?.plan ?? "free";
  const charged = Math.abs(data.breakdown["task_charge"] ?? 0);
  const refunded = data.breakdown["task_refund"] ?? 0;

  const runwayLabel =
    data.runwayDays === null
      ? "—"
      : data.runwayDays >= 365
        ? "1y+"
        : `~${Math.max(0, Math.round(data.runwayDays))}d`;

  return (
    <main>
      <h1>Balance</h1>
      <p className="sub">
        Your conglomerate wallet is real money, burned at the true API cost of each task — every
        grant, charge and refund is on the ledger.
      </p>

      {/* Balance + breakdown (all in euros) */}
      <div className="pnl">
        <div>
          <span>Balance</span>
          <b className={data.balance > 0 ? "pos" : ""}>{eur(data.balance)}</b>
        </div>
        <div>
          <span>Runway</span>
          <b>{runwayLabel}</b>
        </div>
        <div>
          <span>Burn / day</span>
          <b>{eur(data.burnCentsPerDay)}</b>
        </div>
        <div>
          <span>Spent on API</span>
          <b>{eur(charged - refunded)}</b>
        </div>
        <div>
          <span>Plan</span>
          <b style={{ textTransform: "capitalize" }}>{currentPlan}</b>
        </div>
      </div>

      {/* Top up — add real money to the wallet (§10 pillar 1, Stage 2) */}
      <section style={{ marginTop: "2rem" }}>
        <h2 style={{ fontSize: "1.05rem" }}>Top up wallet</h2>
        <p className="sub" style={{ marginTop: "0.25rem" }}>
          Add funds to keep your companies running. The wallet is spent at the real API cost of
          each task.
        </p>
        <div style={{ display: "flex", gap: "0.6rem", marginTop: "0.75rem", flexWrap: "wrap" }}>
          {[1000, 2500, 10000].map((cents) => (
            <button
              key={cents}
              className="btn primary"
              onClick={() => topUp(cents)}
              disabled={toppingUp !== null}
            >
              {toppingUp === cents ? "…" : `Add ${eur(cents)}`}
            </button>
          ))}
        </div>
      </section>

      {/* Payouts — one Stripe Connect account per conglomerate */}
      <section style={{ marginTop: "2rem" }}>
        <h2 style={{ fontSize: "1.05rem" }}>Payouts</h2>
        <p className="sub" style={{ marginTop: "0.25rem" }}>
          Connect a bank account to withdraw your companies&apos; revenue. One account
          covers every company in your conglomerate — Stripe handles identity verification.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginTop: "0.75rem" }}>
          <button className="btn primary" onClick={connectBank} disabled={connecting}>
            {connecting
              ? "…"
              : data.connectAccountId
                ? "Manage payout account"
                : "Connect your bank"}
          </button>
          {data.connectAccountId && (
            <span className="saved" style={{ margin: 0 }}>Bank linked ✓</span>
          )}
        </div>
        {connectMsg && <p className="sub" style={{ marginTop: "0.5rem" }}>{connectMsg}</p>}
      </section>

      {/* Plans */}
      {plans.length > 0 && (
        <section style={{ marginTop: "2rem" }}>
          <h2 style={{ fontSize: "1.05rem" }}>Plans</h2>
          <div className="plan-grid">
            {plans.map((p) => {
              const active = p.id === currentPlan;
              const done = subDone === p.id;
              return (
                <div key={p.id} className={`plan-card ${active ? "active" : ""}`}>
                  <span className="plan-name">{p.name}</span>
                  <span className="plan-price">
                    {p.priceCents === 0 ? "Free" : `${eur(p.priceCents)}${p.oneTime ? "" : "/mo"}`}
                  </span>
                  <span className="sub" style={{ margin: 0 }}>
                    {eur(p.credits)} of API usage{p.oneTime ? " (one-time)" : "/month"}
                  </span>
                  {active ? (
                    <span className="saved" style={{ marginTop: "0.5rem" }}>Current plan ✓</span>
                  ) : (
                    <button
                      className="btn primary"
                      style={{ marginTop: "0.75rem", alignSelf: "flex-start" }}
                      onClick={() => subscribeTo(p.id)}
                      disabled={!!subscribing || done}
                    >
                      {subscribing === p.id ? "…" : done ? "Subscribed ✓" : p.priceCents === 0 ? "Switch to free" : `Subscribe`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {subError && <p className="auth-error" style={{ marginTop: "0.75rem" }}>{subError}</p>}
        </section>
      )}

      {/* Credit entry log */}
      <section style={{ marginTop: "2rem" }}>
        <h2 style={{ fontSize: "1.05rem" }}>Credit log</h2>
        {data.entries.length === 0 && <p className="sub">No credit activity yet.</p>}
        {data.entries.length > 0 && (
          <table className="board">
            <thead>
              <tr>
                <th>Date</th>
                <th>Reason</th>
                <th>Company</th>
                <th className="num">Delta</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.id}>
                  <td style={{ color: "var(--muted)", fontSize: "0.82rem" }}>{dt(e.createdAt)}</td>
                  <td>{REASON_LABELS[e.reason] ?? e.reason}</td>
                  <td>
                    {e.companyName ? (
                      <Link href={`/c/${e.companyId}`} style={{ textDecoration: "underline" }}>
                        {e.companyName}
                      </Link>
                    ) : (
                      <span className="sub" style={{ margin: 0 }}>—</span>
                    )}
                  </td>
                  <td className={`num ${e.delta >= 0 ? "pos" : ""}`} style={e.delta < 0 ? { color: "var(--red)" } : {}}>
                    {e.delta >= 0 ? "+" : ""}{e.delta.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

/** Shown in demo mode — illustrates the shape of the page without real data. */
function DemoCreditView() {
  const demoEntries = [
    { id: "1", delta: 10, reason: "grant", companyName: null, createdAt: new Date(Date.now() - 3600_000 * 24 * 7).toISOString() },
    { id: "2", delta: -1, reason: "task_charge", companyName: "Sell Handmade Ceramic", createdAt: new Date(Date.now() - 3600_000 * 5).toISOString() },
    { id: "3", delta: 0, reason: "task_refund", companyName: "A Newsletter About", createdAt: new Date(Date.now() - 3600_000 * 2).toISOString() },
  ];
  return (
    <>
      <div className="pnl">
        <div><span>Balance</span><b className="pos">9.00</b></div>
        <div><span>Total granted</span><b>10.00</b></div>
        <div><span>Task charges</span><b>1.00</b></div>
        <div><span>Plan</span><b>Free</b></div>
      </div>
      <section style={{ marginTop: "2rem" }}>
        <h2 style={{ fontSize: "1.05rem" }}>Payouts</h2>
        <p className="sub" style={{ marginTop: "0.25rem" }}>
          Connect a bank account to withdraw revenue — one account per conglomerate.
        </p>
        <button className="btn primary" style={{ marginTop: "0.75rem" }} disabled>
          Connect your bank
        </button>
      </section>
      <section style={{ marginTop: "2rem" }}>
        <h2 style={{ fontSize: "1.05rem" }}>Plans</h2>
        <div className="plan-grid">
          {[
            { name: "Free", price: "Free", credits: "10 credits (one-time)", active: true },
            { name: "Builder", price: "€29/mo", credits: "100 credits/month", active: false },
            { name: "Pro", price: "€99/mo", credits: "500 credits/month", active: false },
          ].map((p) => (
            <div key={p.name} className={`plan-card ${p.active ? "active" : ""}`}>
              <span className="plan-name">{p.name}</span>
              <span className="plan-price">{p.price}</span>
              <span className="sub" style={{ margin: 0 }}>{p.credits}</span>
              {p.active ? <span className="saved" style={{ marginTop: "0.5rem" }}>Current plan ✓</span> : <button className="btn primary" style={{ marginTop: "0.75rem" }} disabled>Subscribe</button>}
            </div>
          ))}
        </div>
      </section>
      <section style={{ marginTop: "2rem" }}>
        <h2 style={{ fontSize: "1.05rem" }}>Credit log</h2>
        <table className="board">
          <thead><tr><th>Date</th><th>Reason</th><th>Company</th><th className="num">Delta</th></tr></thead>
          <tbody>
            {demoEntries.map((e) => (
              <tr key={e.id}>
                <td style={{ color: "var(--muted)", fontSize: "0.82rem" }}>{new Date(e.createdAt).toLocaleString()}</td>
                <td>{REASON_LABELS[e.reason]}</td>
                <td>{e.companyName ?? <span className="sub" style={{ margin: 0 }}>—</span>}</td>
                <td className={`num ${e.delta >= 0 ? "pos" : ""}`} style={e.delta < 0 ? { color: "var(--red)" } : {}}>{e.delta >= 0 ? "+" : ""}{e.delta.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
