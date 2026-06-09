import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Gateway tokens (§7): HMAC-signed, scoped to {company, task}, short-lived.
 * Format: base64url(json payload) + "." + base64url(hmac-sha256).
 * Infisical machine identities replace this for sandbox secrets in M3+;
 * this token only authorizes MCP gateway calls.
 */

export interface GatewayScope {
  companyId: string;
  taskId: string;
  exp: number; // unix seconds
}

function secret(): string {
  return process.env.GATEWAY_SECRET ?? "dev-gateway-secret";
}

const b64u = (b: Buffer) => b.toString("base64url");

export function signToken(scope: GatewayScope): string {
  const payload = Buffer.from(JSON.stringify(scope));
  const mac = createHmac("sha256", secret()).update(payload).digest();
  return `${b64u(payload)}.${b64u(mac)}`;
}

export function verifyToken(token: string): GatewayScope | null {
  const [p, m] = token.split(".");
  if (!p || !m) return null;
  const payload = Buffer.from(p, "base64url");
  const expected = createHmac("sha256", secret()).update(payload).digest();
  const got = Buffer.from(m, "base64url");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  try {
    const scope = JSON.parse(payload.toString()) as GatewayScope;
    if (typeof scope.exp !== "number" || scope.exp < Date.now() / 1000) return null;
    if (!scope.companyId || !scope.taskId) return null;
    return scope;
  } catch {
    return null;
  }
}
