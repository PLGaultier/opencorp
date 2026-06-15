import type { SecretStore } from "./store";

/**
 * Real per-company secrets on self-hosted Infisical (§3, §12). One project, one
 * environment, a folder per company under `/companies/{companyId}`; the platform
 * authenticates with a machine identity (Universal Auth) and reads/writes raw
 * secrets over HTTPS. Per-company isolation is by secret path; the harder
 * prod-hardening (a project + scoped machine identity *per* company, §5.3) keeps
 * this same interface.
 */
export interface InfisicalConfig {
  url: string;
  clientId: string;
  clientSecret: string;
  /** Project (workspace) holding all company folders. */
  projectId: string;
  /** Environment slug, e.g. "prod". */
  environment: string;
}

export function infisicalEnv(
  env: Record<string, string | undefined> = process.env,
): InfisicalConfig | null {
  const url = env.INFISICAL_URL;
  const clientId = env.INFISICAL_CLIENT_ID;
  const clientSecret = env.INFISICAL_CLIENT_SECRET;
  const projectId = env.INFISICAL_PROJECT_ID;
  if (!url || !clientId || !clientSecret || !projectId) return null;
  return {
    url: url.replace(/\/$/, ""),
    clientId,
    clientSecret,
    projectId,
    environment: env.INFISICAL_ENV ?? "prod",
  };
}

const COMPANY_ROOT = "/companies";
export const companyPath = (companyId: string) => `${COMPANY_ROOT}/${companyId}`;

/** Authenticated Infisical HTTP client with a cached, auto-refreshed access token. */
export class InfisicalClient {
  private token: { value: string; expiresAt: number } | null = null;

  /**
   * @param staticToken pre-acquired bearer token (e.g. a Token-Auth instance
   *   admin JWT from the bootstrap flow). When set, Universal Auth login is
   *   skipped — used for headless provisioning/validation.
   */
  constructor(
    private cfg: InfisicalConfig,
    private staticToken?: string,
  ) {}

  /** Universal Auth login; token cached until ~30 s before expiry. */
  private async accessToken(): Promise<string> {
    if (this.staticToken) return this.staticToken;
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const res = await fetch(`${this.cfg.url}/api/v1/auth/universal-auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret }),
    });
    if (!res.ok) throw new Error(`infisical login failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { accessToken: string; expiresIn: number };
    this.token = {
      value: body.accessToken,
      expiresAt: Date.now() + Math.max(0, body.expiresIn - 30) * 1000,
    };
    return this.token.value;
  }

  private async authed(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.accessToken();
    return fetch(`${this.cfg.url}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });
  }

  private query(secretPath: string): string {
    const q = new URLSearchParams({
      workspaceId: this.cfg.projectId,
      environment: this.cfg.environment,
      secretPath,
    });
    return q.toString();
  }

  /** Raw secret value at `secretPath`, or null when absent (404). */
  async getSecret(key: string, secretPath: string): Promise<string | null> {
    const res = await this.authed(`/api/v3/secrets/raw/${encodeURIComponent(key)}?${this.query(secretPath)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`infisical get ${key} failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { secret?: { secretValue?: string } };
    return body.secret?.secretValue ?? null;
  }

  /** Create-or-update a raw secret at `secretPath` (idempotent upsert). */
  async setSecret(key: string, value: string, secretPath: string): Promise<void> {
    const create = await this.authed(`/api/v3/secrets/raw/${encodeURIComponent(key)}`, {
      method: "POST",
      body: JSON.stringify({
        workspaceId: this.cfg.projectId,
        environment: this.cfg.environment,
        secretPath,
        secretValue: value,
      }),
    });
    if (create.ok) return;
    // Already exists → update in place.
    if (create.status === 400 || create.status === 409) {
      const update = await this.authed(`/api/v3/secrets/raw/${encodeURIComponent(key)}`, {
        method: "PATCH",
        body: JSON.stringify({
          workspaceId: this.cfg.projectId,
          environment: this.cfg.environment,
          secretPath,
          secretValue: value,
        }),
      });
      if (!update.ok) throw new Error(`infisical update ${key} failed: ${update.status} ${await update.text()}`);
      return;
    }
    throw new Error(`infisical set ${key} failed: ${create.status} ${await create.text()}`);
  }

  /** Create a folder (idempotent: an existing folder is success). */
  async ensureFolder(name: string, path: string): Promise<void> {
    const res = await this.authed(`/api/v1/folders`, {
      method: "POST",
      body: JSON.stringify({
        workspaceId: this.cfg.projectId,
        environment: this.cfg.environment,
        name,
        path,
      }),
    });
    if (res.ok) return;
    const text = await res.text();
    if (res.status === 409 || /exist/i.test(text)) return;
    throw new Error(`infisical create folder ${path}/${name} failed: ${res.status} ${text}`);
  }
}

/** SecretStore over Infisical: per-company path → platform default → null. */
export class InfisicalSecretStore implements SecretStore {
  private client: InfisicalClient;
  constructor(cfg: InfisicalConfig, client?: InfisicalClient) {
    this.client = client ?? new InfisicalClient(cfg);
  }

  async get(companyId: string, key: string): Promise<string | null> {
    const scoped = await this.client.getSecret(key, companyPath(companyId));
    if (scoped !== null) return scoped;
    return this.client.getSecret(key, "/"); // platform-wide default
  }
}

/** Provision + write side, used by CreateCompany and the signed admin route. */
export class InfisicalAdmin {
  constructor(private client: InfisicalClient) {}

  /** Ensure `/companies/{companyId}` exists (and its parent). Idempotent. */
  async ensureCompanyFolder(companyId: string): Promise<void> {
    await this.client.ensureFolder("companies", "/");
    await this.client.ensureFolder(companyId, COMPANY_ROOT);
  }

  setCompanySecret(companyId: string, key: string, value: string): Promise<void> {
    return this.client.setSecret(key, value, companyPath(companyId));
  }
}
