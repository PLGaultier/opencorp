/**
 * Secret resolution (§3 Infisical, §7.3). Per-company secrets — Stripe keys,
 * Stalwart credentials, BYO enrichment keys — live in Infisical in prod and are
 * injected into sandboxes via a machine identity. In dev there is no Infisical:
 * secrets resolve from the process environment, namespaced per company with a
 * platform-wide fallback:
 *
 *   OPENCORP_SECRET__<COMPANYID>__<KEY>   per-company override
 *   OPENCORP_SECRET__<KEY>                platform-wide default
 *
 * `null` means "no credential configured" — capability providers must degrade
 * to local/offline mode (DB-backed mirror) rather than fail. This keeps the
 * whole platform runnable with zero external accounts (the M2/M3 dev contract).
 */
export interface SecretStore {
  get(companyId: string, key: string): Promise<string | null>;
}

const norm = (s: string) => s.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

export class EnvSecretStore implements SecretStore {
  async get(companyId: string, key: string): Promise<string | null> {
    return (
      process.env[`OPENCORP_SECRET__${norm(companyId)}__${key}`] ??
      process.env[`OPENCORP_SECRET__${key}`] ??
      null
    );
  }
}

// The Infisical-backed store lands with the sandbox machine-identity work (M4);
// the interface is stable so capability providers never change.
export function secretStoreFromEnv(): SecretStore {
  return new EnvSecretStore();
}
