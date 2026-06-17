"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { API_URL, GITHUB_ENABLED } from "@/lib/data";
import { signIn, signUp } from "@/lib/auth-client";

/**
 * Sign in / sign up (§3 Better Auth). Leads with GitHub OAuth when configured;
 * email + password stays as a fallback. Signing up creates the user's
 * conglomerate server-side, so they can create companies right away. Public
 * pages never require this — auth gates owner actions only.
 */
export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  // Show the password form only when GitHub isn't available, or on request.
  const [showEmail, setShowEmail] = useState(!GITHUB_ENABLED);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res =
        mode === "signin"
          ? await signIn.email({ email, password })
          : await signUp.email({ email, password, name: name || email.split("@")[0]! });
      if (res.error) {
        setError(res.error.message ?? "authentication failed");
      } else {
        router.push("/");
        router.refresh();
      }
    } catch {
      setError("API unreachable");
    } finally {
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

  return (
    <main>
      <h1>{mode === "signin" ? "Sign in" : "Create account"}</h1>
      <p className="sub">
        {mode === "signin"
          ? "Owner controls (create, run, pause, chat, withdraw) require an account."
          : "Signing up creates your conglomerate — you can launch companies immediately."}
      </p>

      {GITHUB_ENABLED && (
        <>
          <button className="btn primary" onClick={github} disabled={busy} style={{ width: "100%" }}>
            {busy ? "…" : "Continue with GitHub"}
          </button>
          {error && !showEmail && <p className="auth-error">{error}</p>}
          <button
            className="btn link"
            onClick={() => setShowEmail((v) => !v)}
            style={{ marginTop: "0.75rem" }}
          >
            {showEmail ? "hide email sign-in" : "use email instead"}
          </button>
        </>
      )}

      {showEmail && (
      <form onSubmit={submit} className="auth-form">
        {mode === "signup" && (
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            autoComplete="name"
          />
        )}
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          type="email"
          required
          autoComplete="email"
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password (8+ characters)"
          type="password"
          required
          minLength={8}
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
        />
        {error && <p className="auth-error">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "…" : mode === "signin" ? "Sign in" : "Sign up"}
        </button>
      </form>
      )}

      {showEmail && (
      <p className="sub" style={{ marginTop: "1rem" }}>
        {mode === "signin" ? (
          <>
            No account?{" "}
            <button className="btn link" onClick={() => setMode("signup")}>
              Sign up
            </button>
          </>
        ) : (
          <>
            Already have one?{" "}
            <button className="btn link" onClick={() => setMode("signin")}>
              Sign in
            </button>
          </>
        )}
      </p>
      )}
    </main>
  );
}
