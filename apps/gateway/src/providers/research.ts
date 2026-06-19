/**
 * Web research via Anthropic's server-side web_search tool (§7.1). One Messages
 * API call: Claude searches the live web and returns cited results, which we hand
 * back to the agent as {title, url} hits + a short synthesis. The agent then
 * browser.navigate/extracts the promising URLs (e.g. to qualify leads).
 *
 * Billed at $10 / 1,000 searches plus the tokens for the results pulled into
 * context — the usage rides back to the worker via the tool's `_meter` field and
 * is priced in packages/llm/pricing.ts so the wallet stays honest.
 *
 * Requires ANTHROPIC_API_KEY (set platform-wide) and web search enabled for the
 * org in the Claude Console. We call Anthropic directly (not via LiteLLM) so the
 * server-side tool result comes back intact; Haiku + basic web_search keeps it
 * cheap and model-agnostic to the company's brains level.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const RESEARCH_MODEL = process.env.RESEARCH_MODEL ?? "claude-haiku-4-5";

export interface SearchHit {
  title: string;
  url: string;
  age?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchHit[];
  summary: string;
  /** For wallet metering (§10): the resolved model + token/search usage. */
  model: string;
  usage: { input: number; output: number; searchRequests: number };
}

interface AnthropicResultEntry {
  type: string;
  url?: string;
  title?: string;
  page_age?: string;
}
interface AnthropicBlock {
  type: string;
  text?: string;
  content?: AnthropicResultEntry[];
}
interface AnthropicMessage {
  model?: string;
  content?: AnthropicBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    server_tool_use?: { web_search_requests?: number };
  };
}

export async function webSearch(query: string, maxResults = 8): Promise<SearchResponse> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return {
      query,
      results: [],
      summary: "web search unavailable: ANTHROPIC_API_KEY not set",
      model: "none",
      usage: { input: 0, output: 0, searchRequests: 0 },
    };
  }
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: RESEARCH_MODEL,
      max_tokens: 1024,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      messages: [
        {
          role: "user",
          content: `Search the web for: ${query}\n\nReturn the most relevant, recent results.`,
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`web_search failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as AnthropicMessage;
  const blocks = data.content ?? [];
  const seen = new Set<string>();
  const results: SearchHit[] = [];
  for (const b of blocks) {
    if (b.type !== "web_search_tool_result" || !Array.isArray(b.content)) continue;
    for (const r of b.content) {
      if (r.type === "web_search_result" && r.url && !seen.has(r.url)) {
        seen.add(r.url);
        results.push({ title: r.title ?? r.url, url: r.url, age: r.page_age });
        if (results.length >= maxResults) break;
      }
    }
    if (results.length >= maxResults) break;
  }
  const summary = blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join(" ")
    .trim()
    .slice(0, 1500);
  return {
    query,
    results,
    summary,
    model: data.model ?? RESEARCH_MODEL,
    usage: {
      input: data.usage?.input_tokens ?? 0,
      output: data.usage?.output_tokens ?? 0,
      searchRequests: data.usage?.server_tool_use?.web_search_requests ?? 0,
    },
  };
}
