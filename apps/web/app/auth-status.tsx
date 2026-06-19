"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { API_URL, AUTH_DISABLED } from "@/lib/data";
import { signOut, useSession } from "@/lib/auth-client";

/** Round avatar: GitHub photo when present, else the initial on an accent chip. */
export function Avatar({
  name,
  email,
  image,
  size = 26,
}: {
  name?: string | null;
  email?: string | null;
  image?: string | null;
  size?: number;
}) {
  const initial = (name || email || "?").trim().charAt(0).toUpperCase();
  if (image) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        className="avatar"
        src={image}
        alt={name || email || "avatar"}
        width={size}
        height={size}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span className="avatar avatar--fallback" style={{ width: size, height: size, fontSize: size * 0.45 }}>
      {initial}
    </span>
  );
}

/** Nav session control: avatar + dropdown (Account / Sign out) when authed. */
export function AuthStatus() {
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // close the dropdown on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!API_URL || isPending) return null;
  // Frictionless local MVP: no account needed, so don't nag to sign in.
  if (AUTH_DISABLED) return <span className="sub" style={{ margin: 0 }}>local dev</span>;
  if (!session) {
    return (
      <Link href="/login" className="link">
        Sign in
      </Link>
    );
  }

  const { name, email, image } = session.user;
  return (
    <div className="account-menu" ref={ref}>
      <button
        className="account-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={name || email}
      >
        <Avatar name={name} email={email} image={image} />
        <span className="account-name">{name || email}</span>
        <span className="account-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="account-dropdown" role="menu">
          <div className="account-head">
            <Avatar name={name} email={email} image={image} size={36} />
            <div className="account-head-text">
              <strong>{name || email}</strong>
              {name && <span className="sub">{email}</span>}
            </div>
          </div>
          <Link href="/account" className="account-item" role="menuitem" onClick={() => setOpen(false)}>
            Account
          </Link>
          <button
            className="account-item danger"
            role="menuitem"
            onClick={async () => {
              setOpen(false);
              await signOut();
              router.refresh();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
