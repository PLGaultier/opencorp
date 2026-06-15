/**
 * Secret resolution for the gateway. The implementation now lives in
 * @opencorp/secrets (real Infisical vault + env-backed dev store); this module
 * re-exports the stable seam so existing imports (`secretStoreFromEnv`,
 * `SecretStore`) are unchanged. See §3 Infisical, §7.3.
 */
export {
  secretStoreFromEnv,
  EnvSecretStore,
  InfisicalSecretStore,
  InfisicalClient,
  InfisicalAdmin,
  infisicalEnv,
  type SecretStore,
  type InfisicalConfig,
} from "@opencorp/secrets";
