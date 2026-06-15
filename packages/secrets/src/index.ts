import { EnvSecretStore, type SecretStore } from "./store";
import { InfisicalSecretStore, infisicalEnv } from "./infisical";

export { type SecretStore, EnvSecretStore } from "./store";
export {
  InfisicalSecretStore,
  InfisicalClient,
  InfisicalAdmin,
  infisicalEnv,
  companyPath,
  type InfisicalConfig,
} from "./infisical";

/**
 * Pick the secret backend from env: real Infisical when fully configured
 * (INFISICAL_URL + machine-identity creds + project), else the env-backed dev
 * store. Capability providers call this and never learn which one they got.
 */
export function secretStoreFromEnv(): SecretStore {
  const cfg = infisicalEnv();
  return cfg ? new InfisicalSecretStore(cfg) : new EnvSecretStore();
}
