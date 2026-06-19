"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { API_URL, AUTH_DISABLED } from "@/lib/data";
import { useSession } from "@/lib/auth-client";

/**
 * §6 — one prompt → company. POST /companies blocks until the company is
 * fully provisioned (site, email, DB, repo, CEO), so the pending state can
 * last tens of seconds with a real LLM.
 */
export default function NewCompanyPage() {
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Founding a company requires an account — bounce signed-out visitors to login
  // (once the session has resolved). The API also enforces this (requireAuth).
  useEffect(() => {
    if (!API_URL || AUTH_DISABLED) return;
    if (!isPending && !session) router.replace("/login");
  }, [isPending, session, router]);

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
    <main>
      <h1>New company</h1>
      <p className="sub">
        One prompt founds a company: live website, email, database, Git repo and a CEO agent —
        every step on the public ledger.
      </p>

      <form onSubmit={submit} className="auth-form" style={{ maxWidth: "36rem" }}>
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
          {busy
            ? "Founding your company… (extracting spec, provisioning site, hiring CEO)"
            : "Found company"}
        </button>
      </form>
    </main>
  );
}
