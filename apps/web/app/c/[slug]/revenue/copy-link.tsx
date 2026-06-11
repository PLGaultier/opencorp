"use client";

import { useState } from "react";

/** Copy-to-clipboard button for a product payment link. */
export function CopyLink({ href }: { href: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.open(href, "_blank");
    }
  };

  return (
    <button className="btn" onClick={copy} style={{ fontSize: "0.75rem", marginTop: "0.5rem" }}>
      {copied ? "✓ Copied" : "Copy payment link"}
    </button>
  );
}
