"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { API_URL, AUTH_DISABLED } from "@/lib/data";
import { signOut, useSession } from "@/lib/auth-client";
import { Avatar } from "../auth-status";

function formatDate(d?: string | Date | null): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

/** Account page: your identity + classic sign-out. GitHub OAuth (§3). */
export default function AccountPage() {
  const router = useRouter();
  const { data: session, isPending } = useSession();

  // bounce signed-out visitors to login (once we know there's no session)
  useEffect(() => {
    if (!API_URL || AUTH_DISABLED) return;
    if (!isPending && !session) router.replace("/login");
  }, [isPending, session, router]);

  if (!API_URL || AUTH_DISABLED) {
    return (
      <main>
        <Link href="/" className="backlink">← Dashboard</Link>
        <h1>Account</h1>
        <p className="sub">
          Auth is disabled in this build (local single-owner mode). Set{" "}
          <code>OPENCORP_AUTH_DISABLED=0</code> with GitHub credentials to enable real accounts.
        </p>
      </main>
    );
  }

  if (isPending) return <main><p className="sub">Loading…</p></main>;
  if (!session) return null; // redirecting

  const { name, email, image, createdAt } = session.user;
  return (
    <main className="account-page">
      <Link href="/" className="backlink">← Dashboard</Link>
      <h1>Account</h1>
      <p className="sub">Your identity on OpenCorp. Signed in with GitHub.</p>

      <div className="card account-card">
        <div className="account-card-head">
          <Avatar name={name} email={email} image={image} size={64} />
          <div>
            <h2 style={{ margin: 0 }}>{name || email}</h2>
            <p className="sub" style={{ margin: 0 }}>{email}</p>
          </div>
        </div>

        <dl className="account-facts">
          <div>
            <dt>Provider</dt>
            <dd>GitHub</dd>
          </div>
          <div>
            <dt>Member since</dt>
            <dd>{formatDate(createdAt)}</dd>
          </div>
        </dl>

        <button
          className="btn"
          onClick={async () => {
            await signOut();
            router.push("/login");
            router.refresh();
          }}
        >
          Sign out
        </button>
      </div>
    </main>
  );
}
