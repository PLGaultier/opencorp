/**
 * Embeddings for semantic lesson recall (§lessons phase 2). Optional and gated:
 * Anthropic has no embeddings API, so this rides the same OpenAI-compatible
 * LiteLLM proxy as chat, pointed at whatever embedding model the deployment
 * configures (e.g. Voyage's 1024-dim voyage-3). With no EMBEDDING_MODEL set the
 * whole feature degrades to score-ranked + keyword search — the laptop MVP stays
 * runnable on one chat key, exactly like the offline LLM fallbacks elsewhere.
 */

/** The `lessons.embedding` column is vector(1024); a model with other dims is skipped. */
export const EMBED_DIMS = 1024;

export interface EmbedConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export function embedConfigFromEnv(): EmbedConfig | null {
  const baseUrl = process.env.LITELLM_URL;
  const model = process.env.EMBEDDING_MODEL;
  if (!baseUrl || !model) return null;
  return { baseUrl, apiKey: process.env.LITELLM_API_KEY, model };
}

export async function embed(cfg: EmbedConfig, input: string): Promise<number[]> {
  const res = await fetch(`${cfg.baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: cfg.model, input }),
  });
  if (!res.ok) throw new Error(`embeddings failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { data?: { embedding?: number[] }[] };
  const vec = data.data?.[0]?.embedding;
  if (!vec?.length) throw new Error("embeddings returned no vector");
  return vec;
}

/**
 * Embed `input`, or return null when embeddings aren't configured, the call
 * fails, or the model's dimensionality doesn't match the column — every caller
 * must tolerate null and fall back to keyword/score ranking. Never throws.
 */
export async function embedMaybe(input: string): Promise<number[] | null> {
  const cfg = embedConfigFromEnv();
  if (!cfg) return null;
  try {
    const vec = await embed(cfg, input);
    return vec.length === EMBED_DIMS ? vec : null;
  } catch {
    return null;
  }
}

/** pgvector text literal, e.g. [0.1,0.2,...] — cast with `::vector` at the call site. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
