"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { API_URL } from "@/lib/data";

/**
 * Owner email actions: mark-as-read. Replies go through the CEO chat
 * (which can call email.reply_email via the org MCP tool) — this keeps
 * the reply on the ledger and under the AI's daily cap discipline.
 */
export function EmailActions({
  companyId,
  emailId,
  direction,
  isRead,
  slug,
}: {
  companyId: string;
  emailId: string;
  direction: "in" | "out";
  isRead: boolean;
  slug: string;
}) {
  const router = useRouter();
  const [read, setRead] = useState(isRead);
  const [busy, setBusy] = useState(false);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const markRead = async () => {
    if (busy || read) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/companies/${companyId}/emails/${emailId}/read`, {
        method: "POST",
        credentials: "include",
      });
      if (res.status === 401 || res.status === 403) {
        setNeedsAuth(true);
      } else if (!res.ok) {
        setError("failed to mark as read");
      } else {
        setRead(true);
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
      <p className="sub">
        Owner actions (mark-read) are available when the dashboard is connected to an API.
      </p>
    );
  }

  if (needsAuth) {
    return (
      <p className="sub">
        Owner actions are limited to conglomerate members —{" "}
        <a href="/login" style={{ textDecoration: "underline" }}>sign in</a>.
      </p>
    );
  }

  return (
    <div className="controls-row">
      {direction === "in" && (
        <button className="btn" onClick={markRead} disabled={busy || read}>
          {read ? "✓ Read" : busy ? "…" : "Mark as read"}
        </button>
      )}
      {direction === "in" && (
        <span className="sub" style={{ margin: 0 }}>
          To reply, use the{" "}
          <a href={`/c/${slug}#controls`} style={{ textDecoration: "underline" }}>
            CEO chat
          </a>{" "}
          — the AI handles replies on the ledger.
        </span>
      )}
      {error && <span className="auth-error">{error}</span>}
    </div>
  );
}
