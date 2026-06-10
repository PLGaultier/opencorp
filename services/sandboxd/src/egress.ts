/**
 * Egress proxy (§8). Every sandbox's network egress goes through a logging
 * filter: only http(s), never RFC1918 / link-local / cloud-metadata, and — when
 * an allowlist is configured — only approved hosts. A decision hook lets the
 * caller record blocked attempts to the transparency ledger. In prod this is a
 * real proxy on the virtio-net TAP; here it's the same policy enforced in TS so
 * the worker behaves identically before and after the move into Firecracker.
 */
const PRIVATE_HOST =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1$|fc00:|fd00:|172\.(1[6-9]|2\d|3[01])\.)/i;

export interface EgressDecision {
  allowed: boolean;
  url: string;
  reason?: "blocked_scheme" | "blocked_private_address" | "not_on_allowlist" | "invalid_url";
}

export interface EgressOptions {
  /** If set, only these hostnames (exact or suffix match) are reachable. */
  allowlist?: string[];
  /** Called for every decision — wire this to the ledger for an audit trail. */
  onDecision?: (d: EgressDecision) => void;
}

export class EgressProxy {
  constructor(private opts: EgressOptions = {}) {}

  check(rawUrl: string): EgressDecision {
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      return this.decide({ allowed: false, url: rawUrl, reason: "invalid_url" });
    }
    if (u.protocol !== "http:" && u.protocol !== "https:")
      return this.decide({ allowed: false, url: rawUrl, reason: "blocked_scheme" });
    if (PRIVATE_HOST.test(u.hostname) || u.hostname === "metadata.google.internal")
      return this.decide({ allowed: false, url: rawUrl, reason: "blocked_private_address" });
    if (this.opts.allowlist && !this.onAllowlist(u.hostname))
      return this.decide({ allowed: false, url: rawUrl, reason: "not_on_allowlist" });
    return this.decide({ allowed: true, url: rawUrl });
  }

  /** Guarded fetch: throws (does not call out) when the policy denies the URL. */
  async fetch(rawUrl: string, init?: RequestInit): Promise<Response> {
    const d = this.check(rawUrl);
    if (!d.allowed) throw new Error(`egress_denied:${d.reason}`);
    return fetch(rawUrl, init);
  }

  private onAllowlist(host: string): boolean {
    return (this.opts.allowlist ?? []).some((h) => host === h || host.endsWith(`.${h}`));
  }

  private decide(d: EgressDecision): EgressDecision {
    this.opts.onDecision?.(d);
    return d;
  }
}
