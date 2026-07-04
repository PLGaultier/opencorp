"use client";

import { useState } from "react";
import { API_URL } from "@/lib/data";
import { AgentSprite } from "../../sprites";

/**
 * The order bar — docked under the terminal so the core loop reads top to
 * bottom: you give an order, the CEO replies here, and the resulting agent
 * activity streams into the terminal above. (Extracted from CompanyControls
 * so the exchange lives next to the feed it drives.)
 */
export function CeoChat({ companyId }: { companyId: string }) {
  const [chat, setChat] = useState<{ role: "owner" | "ceo"; text: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [needsAuth, setNeedsAuth] = useState(false);

  const sendChat = async () => {
    const message = draft.trim();
    if (!message || sending || !API_URL) return;
    setDraft("");
    setChat((c) => [...c, { role: "owner", text: message }]);
    setSending(true);
    try {
      const res = await fetch(`${API_URL}/companies/${companyId}/chat`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (res.status === 401 || res.status === 403) setNeedsAuth(true);
      const d = (await res.json()) as { reply?: string; createdTasks?: string[]; error?: string };
      const reply = d.reply ?? `error: ${d.error ?? "chat failed"}`;
      const queued = d.createdTasks?.length ? `\n[queued: ${d.createdTasks.join(" · ")}]` : "";
      setChat((c) => [...c, { role: "ceo", text: reply + queued }]);
    } catch {
      setChat((c) => [...c, { role: "ceo", text: "error: API unreachable" }]);
    } finally {
      setSending(false);
    }
  };

  if (needsAuth) {
    return (
      <p className="sub" style={{ margin: "0.6rem 0 0" }}>
        Giving orders is limited to this company&apos;s members —{" "}
        <a href="/login" style={{ textDecoration: "underline" }}>sign in</a>.
      </p>
    );
  }

  return (
    <div>
      {chat.length > 0 && (
        <div className="chat" style={{ borderTop: "none", paddingTop: 0 }}>
          {chat.map((m, i) => (
            <div key={i} className={`chat-msg ${m.role}`}>
              {m.role === "ceo" ? <AgentSprite kind="ceo" size={20} /> : null}
              <span className="chat-role">{m.role}</span>
              <span>{m.text}</span>
            </div>
          ))}
        </div>
      )}
      <div className="order-bar">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendChat()}
          placeholder={API_URL ? "Give the CEO an order… (it can queue tasks, never pause itself)" : "Connect an API to give orders — demo replay"}
          disabled={sending || !API_URL}
        />
        <button className="btn primary" onClick={sendChat} disabled={sending || !draft.trim() || !API_URL}>
          {sending ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
