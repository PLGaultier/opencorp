"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { API_URL, AUTH_DISABLED } from "@/lib/data";
import { useSession } from "@/lib/auth-client";
import { Mascot } from "../sprites";

/**
 * §6 — one prompt → company, framed as the game's "new save file" screen.
 * POST /companies blocks until the company is fully provisioned (site, email,
 * DB, repo, CEO), which can take tens of seconds with a real LLM — so the
 * pending state is a CRT provisioning log (cosmetic pacing, the real steps
 * land on the ledger).
 */

const PROVISION_STEPS = [
  "extracting business spec from your prompt…",
  "naming the company + hatching its mascot…",
  "reserving the domain and deploying the site…",
  "provisioning database…",
  "creating the company mailbox…",
  "initializing the git repo…",
  "hiring the CEO and department heads…",
  "scheduling the daily heartbeat… (this can take a minute)",
];

export default function NewCompanyPage() {
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);

  // Founding a company requires an account — bounce signed-out visitors to login
  // (once the session has resolved). The API also enforces this (requireAuth).
  useEffect(() => {
    if (!API_URL || AUTH_DISABLED) return;
    if (!isPending && !session) router.replace("/login");
  }, [isPending, session, router]);

  // Cosmetic provisioning log: reveal the next line every few seconds while
  // the blocking POST runs.
  useEffect(() => {
    if (!busy) {
      setStep(0);
      return;
    }
    const t = setInterval(
      () => setStep((s) => Math.min(s + 1, PROVISION_STEPS.length - 1)),
      4500,
    );
    return () => clearInterval(t);
  }, [busy]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/companies`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim() }),
      });
      const d = (await res.json()) as { slug?: string; error?: string; detail?: string };
      if (res.ok && d.slug) {
        router.push(`/c/${d.slug}`);
        router.refresh();
      } else {
        setError(d.detail ?? d.error ?? "creation failed");
        setBusy(false);
      }
    } catch {
      setError(
        "Lost connection while provisioning — creation may still be running. Check the dashboard shortly.",
      );
      setBusy(false);
    }
  };

  if (!API_URL) {
    return (
      <main>
        <h1>New company</h1>
        <p className="sub">
          Demo preview — connect the dashboard to an API to found companies from one prompt.
        </p>
      </main>
    );
  }

  // While the session resolves, or during the redirect for signed-out users,
  // render nothing rather than flashing the form.
  if (!AUTH_DISABLED && (isPending || !session)) return null;

  return (
    <main className="found">
      <h1>Found a new company</h1>
      <p className="sub">
        One sentence is the whole setup — site, email, database, repo and a CEO agent, every step
        on the public ledger.
      </p>

      {busy ? (
        /* the "hatching" screen — cosmetic log while the blocking POST runs */
        <div className="terminal found-log">
          <div className="term-head">
            <span className="term-live on" />
            <span className="term-title">Founding — provisioning your company</span>
          </div>
          <div className="term-body">
            {PROVISION_STEPS.slice(0, step + 1).map((s, i) => (
              <div className="tl" key={s}>
                <span className="tl-time" />
                <span className="tl-actor a-system">[SYS ]</span>
                <span className={`tl-body ${i < step ? "ok" : ""}`}>
                  {s} {i < step && "✓"}
                </span>
              </div>
            ))}
            <div className="tl">
              <span className="tl-time" />
              <span className="tl-actor" />
              <span className="tl-body dim">▮</span>
            </div>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="found-form">
          <div className="found-mascot">
            <Mascot slug={prompt || "opencorp"} size={72} />
            <span className="sub">
              your company&apos;s mascot — it shifts as you type, and hatches for good at founding
            </span>
          </div>

          <div className="auth-form" style={{ maxWidth: "36rem", marginTop: 0 }}>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe the business… e.g. sell handmade ceramic mugs online to coffee lovers"
              rows={5}
              minLength={10}
              maxLength={2000}
              required
              disabled={busy}
            />
            <span className="sub">{prompt.length}/2000</span>
            {error && <p className="auth-error">{error}</p>}
            <button className="btn primary" type="submit" disabled={busy || prompt.trim().length < 10}>
              ▶ Found company
            </button>
          </div>
        </form>
      )}
    </main>
  );
}
