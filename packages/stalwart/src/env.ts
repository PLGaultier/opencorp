/**
 * Real email (§3 Stalwart, §6, §7.1 email-mcp). One Stalwart instance per
 * deployment, one mailbox per company (`{slug}@{MAIL_DOMAIN}`). Configuration is
 * platform-level env; when STALWART_URL is unset every consumer degrades to
 * local mode (DB mirror only, nothing leaves) — the zero-external-accounts dev
 * contract.
 */
export interface StalwartConfig {
  /** Base URL of the Stalwart HTTP listener (JMAP + management API). */
  url: string;
  adminUser: string;
  adminSecret: string;
  /** Master secret from which per-mailbox passwords are derived (see derive.ts). */
  masterSecret: string;
  /** Mail domain for company addresses, e.g. opencorp.app (prod) / opencorp.test (dev). */
  domain: string;
}

export function stalwartEnv(env: Record<string, string | undefined> = process.env): StalwartConfig | null {
  const url = env.STALWART_URL;
  if (!url) return null;
  return {
    url: url.replace(/\/$/, ""),
    adminUser: env.STALWART_ADMIN_USER ?? "admin",
    adminSecret: env.STALWART_ADMIN_SECRET ?? "opencorp-dev-admin",
    masterSecret: env.STALWART_MASTER_SECRET ?? "opencorp-dev-mail-master",
    domain: env.MAIL_DOMAIN ?? env.OPENCORP_DOMAIN ?? "localhost",
  };
}
