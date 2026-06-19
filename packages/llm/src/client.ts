/**
 * Minimal OpenAI-compatible chat client pointed at the LiteLLM proxy (§3).
 * Tier names ("frontier" | "standard" | "mini") map to LiteLLM model_list.
 */
import type { Tracer } from "./trace";
import { shiftTier } from "./levels";

export type ModelTier = "frontier" | "standard" | "mini";

export interface ChatOptions {
  tier: ModelTier;
  system?: string;
  user: string;
  jsonOnly?: boolean;
  maxTokens?: number;
  /** When set, the generation is recorded on the Langfuse trace (§9.2). */
  trace?: { tracer: Tracer; traceId: string; name?: string };
}

export interface LlmConfig {
  baseUrl: string; // e.g. http://localhost:4000
  apiKey?: string; // LiteLLM virtual key (per-company in later milestones)
  /**
   * Per-company shift along the tier ladder (§10, set by the CEO "brains" level).
   * Negative = cheaper models, positive = pricier; 0 keeps the requested tier.
   */
  tierShift?: number;
}

export function llmConfigFromEnv(): LlmConfig | null {
  const baseUrl = process.env.LITELLM_URL;
  if (!baseUrl) return null;
  return { baseUrl, apiKey: process.env.LITELLM_API_KEY };
}

export interface ChatResult {
  content: string;
  /** The model LiteLLM actually served (for cost metering, §10 pillar 1). */
  model: string;
  usage: { input: number; output: number };
}

/** Like {@link chat} but also returns the resolved model + token usage so the
 *  caller can meter real API cost. */
export async function chatRaw(cfg: LlmConfig, opts: ChatOptions): Promise<ChatResult> {
  const startTime = new Date();
  // The company's CEO-level shifts the requested tier up/down the ladder (§10).
  const tier = shiftTier(opts.tier, cfg.tierShift ?? 0);
  const res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: tier,
      max_tokens: opts.maxTokens ?? 2048,
      ...(opts.jsonOnly ? { response_format: { type: "json_object" } } : {}),
      messages: [
        ...(opts.system ? [{ role: "system", content: opts.system }] : []),
        { role: "user", content: opts.user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`llm ${tier} failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error("llm returned empty completion");
  const model = data.model ?? tier;
  const usage = { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 };
  if (opts.trace) {
    opts.trace.tracer.generation({
      traceId: opts.trace.traceId,
      name: opts.trace.name ?? "chat",
      model,
      input: { system: opts.system, user: opts.user },
      output: content,
      ...(data.usage ? { usage } : {}),
      startTime,
      endTime: new Date(),
    });
  }
  return { content, model, usage };
}

export async function chat(cfg: LlmConfig, opts: ChatOptions): Promise<string> {
  return (await chatRaw(cfg, opts)).content;
}
