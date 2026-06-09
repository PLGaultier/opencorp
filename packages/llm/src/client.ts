/**
 * Minimal OpenAI-compatible chat client pointed at the LiteLLM proxy (§3).
 * Tier names ("frontier" | "standard" | "mini") map to LiteLLM model_list.
 */
export type ModelTier = "frontier" | "standard" | "mini";

export interface ChatOptions {
  tier: ModelTier;
  system?: string;
  user: string;
  jsonOnly?: boolean;
  maxTokens?: number;
}

export interface LlmConfig {
  baseUrl: string; // e.g. http://localhost:4000
  apiKey?: string; // LiteLLM virtual key (per-company in later milestones)
}

export function llmConfigFromEnv(): LlmConfig | null {
  const baseUrl = process.env.LITELLM_URL;
  if (!baseUrl) return null;
  return { baseUrl, apiKey: process.env.LITELLM_API_KEY };
}

export async function chat(cfg: LlmConfig, opts: ChatOptions): Promise<string> {
  const res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: opts.tier,
      max_tokens: opts.maxTokens ?? 2048,
      ...(opts.jsonOnly ? { response_format: { type: "json_object" } } : {}),
      messages: [
        ...(opts.system ? [{ role: "system", content: opts.system }] : []),
        { role: "user", content: opts.user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`llm ${opts.tier} failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error("llm returned empty completion");
  return content;
}
