/**
 * Secret resolution (§3 Infisical, §7.3). Per-company secrets — Stripe keys,
 * Stalwart/BYO credentials — resolve through one stable seam so capability
 * providers never change when the backend does:
 *
 *   - InfisicalSecretStore: real per-company vault (prod).
 *   - EnvSecretStore: process env, namespaced per company (dev / no-vault).
 *
 * Lookup order is identical in both: per-company override → platform default →
 * `null`. `null` means "no credential configured" — providers must degrade to
 * local/offline mode rather than fail, so the platform stays runnable with zero
 * external accounts (the dev contract).
 */
export interface SecretStore {
  /** Per-company override, else platform default, else null. */
  get(companyId: string, key: string): Promise<string | null>;
}

const norm = (s: string) => s.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

export class EnvSecretStore implements SecretStore {
  constructor(private env: Record<string, string | undefined> = process.env) {}

  async get(companyId: string, key: string): Promise<string | null> {
    return (
      this.env[`OPENCORP_SECRET__${norm(companyId)}__${key}`] ??
      this.env[`OPENCORP_SECRET__${key}`] ??
      null
    );
  }
}
