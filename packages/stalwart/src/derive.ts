import { createHmac } from "node:crypto";

/**
 * Per-mailbox passwords are *derived*, never stored:
 *   password = HMAC-SHA256(masterSecret, "mailbox:" + address)
 * The provisioning activity (CreateCompany §6) and the gateway's email provider
 * derive the same credential independently, so there is no secret to persist,
 * no write API on the SecretStore, and mailbox provisioning stays idempotent
 * under Temporal retries. In prod the master secret lives in Infisical; rotating
 * it re-keys every mailbox (re-run provisioning to push new secrets).
 */
export function deriveMailboxPassword(masterSecret: string, address: string): string {
  return createHmac("sha256", masterSecret).update(`mailbox:${address.toLowerCase()}`).digest("hex").slice(0, 40);
}
