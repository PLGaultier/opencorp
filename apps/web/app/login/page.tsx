"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { API_URL } from "@/lib/data";
import { signIn, signUp } from "@/lib/auth-client";

/**
 * Sign in / sign up (§3 Better Auth, email + password). Signing up creates
 * the user's conglomerate server-side, so they can create companies right
 * away. Public pages never require this — auth gates owner actions only.
 */
export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    </main>
  );
}
