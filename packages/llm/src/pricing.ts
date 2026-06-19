/**
 * Real API cost metering (§8/§10, revenue pillar 1). Prices are keyed by the
 * actual model id LiteLLM resolves to (the `model` field on a completion), so
 * the conglomerate wallet is debited the *true* cost — promoting a tier from
 * Haiku to Opus shows up as a ~5× bigger debit, not a flat "1 credit".
 *
 * Rates are USD per 1M tokens (Anthropic list prices). The wallet is denominated
 * in cents; we treat 1 USD-cent = 1 wallet-cent for now (EUR/USD FX is a later
 * refinement — record it as a multiplier here when needed).
 */
export interface TokenPrice {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}

export const MODEL_PRICES: Record<string, TokenPrice> = {
  "claude-haiku-4-5": { inputPerMTokUsd: 1, outputPerMTokUsd: 5 },
  "claude-sonnet-4-6": { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
  "claude-opus-4-8": { inputPerMTokUsd: 5, outputPerMTokUsd: 25 },
  "claude-fable-5": { inputPerMTokUsd: 10, outputPerMTokUsd: 50 },
};

// Fallback when the resolved model id isn't in the table (unknown/offline model
// or a tier name). Haiku is the cheapest real model, so it under-bills rather
// than over-bills on a miss.
const FALLBACK: TokenPrice = MODEL_PRICES["claude-haiku-4-5"]!;

// LiteLLM echoes back the requested tier alias (e.g. "standard") as the response
// `model`, not the resolved Anthropic id — so the §10 tier ladder must be mapped
// to its backing model here, or every tier would bill at the FALLBACK (Haiku)
// rate. Keep in sync with infra/compose/litellm.config.yaml.
const TIER_MODEL: Record<string, string> = {
  mini: "claude-haiku-4-5",
  standard: "claude-sonnet-4-6",
  frontier: "claude-opus-4-8",
};

/**
 * Best-match price for a model id. Handles both the tier alias LiteLLM returns
 * ("mini"/"standard"/"frontier") and a real resolved id like
 * `claude-haiku-4-5-20251001` or `anthropic/claude-sonnet-4-6` (substring match).
 */
export function priceFor(model: string): TokenPrice {
  const m = model.toLowerCase();
  const tierBacked = TIER_MODEL[m];
  if (tierBacked) return MODEL_PRICES[tierBacked]!;
  for (const [id, price] of Object.entries(MODEL_PRICES)) {
    if (m.includes(id)) return price;
  }
  return FALLBACK;
}

// Anthropic server-side web_search: $10 per 1,000 searches = $0.01 = 1000
// micro-cents per search, billed on top of the tokens for the results pulled
// into context (§7.1). Each request counts once regardless of result count.
export const SEARCH_REQUEST_MICRO_CENTS = 1000;

/** Token (+ optional web_search) usage from one completion or tool call. */
export interface Usage {
  input: number;
  output: number;
  /** Anthropic web_search_requests, when a call used the web_search tool. */
  searchRequests?: number;
}

/**
 * Cost of one completion in **micro-cents** (integer, 1 cent = 1000 micro-cents)
 * so per-call costs accumulate without float drift; convert to cents at task
 * reconcile time (`Math.round(totalMicro / 1000)`).
 */
export function costMicroCents(model: string, usage: Usage): number {
  const p = priceFor(model);
  // USD/MTok → micro-cents/token is `usd_per_mtok / 10`
  // (×100 cents ×1000 micro ÷ 1_000_000 tokens).
  const inMicro = (usage.input * p.inputPerMTokUsd) / 10;
  const outMicro = (usage.output * p.outputPerMTokUsd) / 10;
  const searchMicro = (usage.searchRequests ?? 0) * SEARCH_REQUEST_MICRO_CENTS;
  return Math.round(inMicro + outMicro + searchMicro);
}

/** Convenience: cost of one completion in cents (may be fractional — for display). */
export function costCents(model: string, usage: Usage): number {
  return costMicroCents(model, usage) / 1000;
}
