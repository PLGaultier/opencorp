"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { API_URL } from "@/lib/data";
import { signOut, useSession } from "@/lib/auth-client";

/** Nav session badge: email + sign out when authed, sign-in link otherwise. */
export function AuthStatus() {
  const router = useRouter();
  const { data: session, isPending } = useSession();

  if (!API_URL || isPending) return null;
  if (!session) {
    return (
      <Link href="/login" className="link">
        Sign in
      </Link>
    );
  }
  return (
    <span className="auth-status">
      <span className="sub" style={{ margin: 0 }}>{session.user.email}</span>
      <button
        className="btn link"
        onClick={async () => {
          await signOut();
          router.refresh();
        }}
      >
        sign out
      </button>
    </span>
  );
}
