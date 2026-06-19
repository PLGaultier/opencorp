"use client";

import { useState } from "react";

/** Compact copy-to-clipboard button for links, addresses and codes. */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable — no-op */
    }
  };

  return (
    <button className="copy-btn" type="button" onClick={copy} aria-label={`Copy ${value}`}>
      {copied ? "✓ Copied" : label}
    </button>
  );
}
