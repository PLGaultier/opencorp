"use client";

import { useState, type ReactNode } from "react";

/**
 * Pokémon-style menu: one panel on screen at a time. The tab nodes are
 * rendered server-side and passed in; this component only switches which one
 * is visible, so cutting information density costs no extra fetches.
 */
export interface MenuTab {
  id: string;
  label: string;
  content: ReactNode;
}

export function DashboardTabs({ tabs, initial }: { tabs: MenuTab[]; initial?: string }) {
  const [active, setActive] = useState(initial ?? tabs[0]?.id);
  const current = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <div className="menu-tabs">
      <div className="menu-bar" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === current?.id}
            className={`menu-btn ${t.id === current?.id ? "on" : ""}`}
            onClick={() => setActive(t.id)}
          >
            <span className="cursor">▸</span>
            {t.label}
          </button>
        ))}
      </div>
      {current && (
        <div className="menu-panel" role="tabpanel">
          {current.content}
        </div>
      )}
    </div>
  );
}
