"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { API_URL, AUTH_DISABLED, GITHUB_ENABLED, demoTerminal, getMyCompanies, type Company } from "@/lib/data";
import { signIn, useSession } from "@/lib/auth-client";
import { AgentSprite, Mascot } from "./sprites";
import { CompanyTerminal } from "./c/[slug]/terminal";

const eur = (cents: number) => `${(cents / 100).toFixed(2)} €`;

function CompanyCard({ c }: { c: Company }) {
  return (
    <Link href={`/c/${c.slug}`} className="card">
      <h2>
        <Mascot slug={c.slug} size={22} paused={c.status === "paused"} />
        {c.name}
      </h2>
      <p className="mission">{c.mission}</p>
      <div className="stats">
        <div><span>Revenue</span><b>{eur(c.revenueCents)}</b></div>
        <div><span>Balance</span><b>{eur(c.balanceCents)}</b></div>
        <div><span>Spent</span><b>{eur(c.spendCents)}</b></div>
        <div><span>Tasks</span><b>{c.tasksDone} done · {c.tasksQueued} queued</b></div>
      </div>
    </Link>
  );
}

/**
 * Auth-aware top of the dashboard. Signed out → a hero that nudges GitHub
 * sign-in and founding your own company. Signed in → your conglomerate: your
 * companies + the New company card (empty-state prompt when you have none).
 */
export function MyConglomerate() {
  const { data: session, isPending } = useSession();
  const authed = AUTH_DISABLED || !!session;
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [wallet, setWallet] = useState<{ balanceCents: number; runwayDays: number | null } | null>(null);

  useEffect(() => {
    if (!authed) {
      setCompanies(null);
      setWallet(null);
      return;
    }
    let live = true;
    void (async () => {
      const cs = await getMyCompanies();
      if (live) setCompanies(cs);
      try {
        const me = await fetch(`${API_URL}/api/me`, { credentials: "include" });
        if (!me.ok) return;
        const { conglomerateIds } = (await me.json()) as { conglomerateIds: string[] };
        const cid = conglomerateIds?.[0];
        if (!cid) return;
        const r = await fetch(`${API_URL}/api/conglomerates/${cid}/credits`, { credentials: "include" });
        if (r.ok && live) {
          const d = (await r.json()) as { balance: number; runwayDays: number | null };
          setWallet({ balanceCents: d.balance, runwayDays: d.runwayDays });
        }
      } catch {
        /* wallet banner is best-effort */
      }
    })();
    return () => {
      live = false;
    };
  }, [authed]);

  // While Better Auth resolves the session, don't flash the signed-out hero.
  if (!AUTH_DISABLED && isPending) return null;

  // ── Signed out: the landing — pitch, proof-of-life terminal, how it works ─
  if (!authed) {
    return (
      <>
        <section className="hero landing">
          <div className="landing-copy">
            <h1 className="landing-title">
              One prompt.
              <br />
              One company.
            </h1>
            <p className="sub">
              Describe the business you wish existed. OpenCorp founds it — website, email, database,
              repo — and a CEO agent runs it while you give orders. Every decision, tool call and
              cent lands on a public, hash-chained ledger.
            </p>
            <div className="landing-cta">
              {GITHUB_ENABLED ? (
                <button
                  className="btn primary github-btn"
                  onClick={() => signIn.social({ provider: "github", callbackURL: `${window.location.origin}/` })}
                >
                  <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
                  </svg>
                  Continue with GitHub
                </button>
              ) : (
                <Link href="/login" className="btn primary">Sign in</Link>
              )}
              <a href="#live" className="btn">Watch the ledger live ↓</a>
            </div>
          </div>
          <div className="landing-crew" aria-hidden>
            <Mascot slug="opencorp" size={72} />
            <AgentSprite kind="ceo" size={52} />
            <AgentSprite kind="dept" size={52} />
            <AgentSprite kind="worker" size={52} />
          </div>
        </section>

        {/* Proof of life: a real heartbeat, replayed in the house CRT. */}
        <section className="landing-floor">
          <CompanyTerminal companyId={null} initialEvents={demoTerminal} />
        </section>

        <section className="steps">
          <div className="card step">
            <span className="step-num">01</span>
            <span className="step-sprite"><AgentSprite kind="ceo" size={30} /></span>
            <h2>Say the word</h2>
            <p className="mission">One sentence is the whole setup. The spec, the name, the mascot — extracted for you.</p>
          </div>
          <div className="card step">
            <span className="step-num">02</span>
            <span className="step-sprite"><AgentSprite kind="worker" size={30} /></span>
            <h2>It ships itself</h2>
            <p className="mission">Site, mailbox, database and repo are provisioned; departments plan and workers execute.</p>
          </div>
          <div className="card step">
            <span className="step-num">03</span>
            <span className="step-sprite"><AgentSprite kind="dept" size={30} /></span>
            <h2>You give orders</h2>
            <p className="mission">Type into the company floor, watch HP and gold move, and cash out real revenue.</p>
          </div>
        </section>
      </>
    );
  }

  // ── Signed in: your conglomerate ─────────────────────────────────────────
  const totalRevenue = (companies ?? []).reduce((s, c) => s + c.revenueCents, 0);
  const totalBalance = (companies ?? []).reduce((s, c) => s + c.balanceCents, 0);
  const totalSpent = (companies ?? []).reduce((s, c) => s + c.spendCents, 0);

  const lowBalance =
    wallet !== null &&
    (wallet.balanceCents < 200 || (wallet.runwayDays !== null && wallet.runwayDays < 3));

  return (
    <section>
      <h1>Your conglomerate</h1>
      {lowBalance && (
        <div className="banner-low">
          {wallet!.balanceCents <= 0
            ? "Your wallet is empty — companies pause until you top up."
            : `Low balance: ${eur(wallet!.balanceCents)}${
                wallet!.runwayDays !== null ? ` · ~${Math.max(0, Math.round(wallet!.runwayDays))}d of runway` : ""
              }.`}{" "}
          <Link href="/credits">Top up →</Link>
        </div>
      )}
      {companies === null ? (
        <p className="sub">Loading your companies…</p>
      ) : (
        <p className="sub">
          {companies.length} {companies.length === 1 ? "company" : "companies"} · {eur(totalRevenue)} revenue ·{" "}
          {eur(totalBalance)} balance · {eur(totalSpent)} spent — every number
          verifiable on the{" "}
          <Link href="/live" style={{ textDecoration: "underline" }}>public ledger</Link>.
        </p>
      )}

      {companies !== null && companies.length === 0 && (
        <p className="sub">You haven&apos;t founded a company yet. One prompt is all it takes.</p>
      )}

      <div className="grid">
        {(companies ?? []).map((c) => (
          <CompanyCard key={c.id} c={c} />
        ))}
        <Link href="/new" className="card new-company">
          <h2>＋ New company</h2>
          <p className="mission">
            One prompt founds a company: website, email, database, repo and a CEO agent.
          </p>
        </Link>
      </div>
    </section>
  );
}
