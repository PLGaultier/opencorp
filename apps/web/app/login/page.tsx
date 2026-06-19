"use client";

import { useState } from "react";
import { API_URL, GITHUB_ENABLED } from "@/lib/data";
import { signIn } from "@/lib/auth-client";

/**
 * Sign in (§3 Better Auth) — GitHub OAuth only. The first GitHub sign-in
 * creates the user's conglomerate server-side, so they can launch companies
 * right away. Public pages never require this — auth gates owner actions only.
 */
export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const github = async () => {
    setError(null);
    setBusy(true);
    try {
      // Absolute URL to the dashboard (:3000). A relative "/" resolves against
      // the API origin (:3001), which has no root route → 404 after auth.
      await signIn.social({ provider: "github", callbackURL: `${window.location.origin}/` });
    } catch {
      setError("GitHub sign-in unreachable");
      setBusy(false);
    }
  };

  if (!API_URL) {
    return (
      <main>
        <h1>Sign in</h1>
        <p className="sub">Demo preview — connect the dashboard to an API to enable accounts.</p>
      </main>
    );
  }

  if (!GITHUB_ENABLED) {
    return (
      <main>
        <h1>Sign in</h1>
        <p className="sub">
          GitHub sign-in isn&apos;t configured. Set <code>GITHUB_CLIENT_ID</code> and{" "}
          <code>GITHUB_CLIENT_SECRET</code> (and <code>OPENCORP_AUTH_DISABLED=0</code>), then restart.
        </p>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <h1>Sign in</h1>
      <p className="sub">
        Owner controls (create, run, pause, chat, withdraw) require an account. Your first sign-in
        creates your conglomerate — you can launch companies immediately.
      </p>

      <button className="btn primary github-btn" onClick={github} disabled={busy}>
        <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
        {busy ? "Redirecting…" : "Continue with GitHub"}
      </button>
      {error && <p className="auth-error">{error}</p>}
    </main>
  );
}
