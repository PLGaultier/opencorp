/**
 * Optional cheap-model intent classifier for routing (OPE-7b).
 *
 * OPE-7 Part 1 detects an owner *directive* with a brittle `task:` prefix regex.
 * This upgrades that one ambiguous case: when `ROUTER_CLASSIFIER=1`, a single
 * `mini`-tier call classifies the message into the same routing signals. It's the
 * only LLM call in the routing path — cheap (floor model, tiny budget) and
 * feature-flagged. On disabled / no-LLM / parse error / exception it falls back
 * to the deterministic `deriveChatSignals`, so default behaviour is unchanged.
 *
 * It runs on the company's own `LlmConfig`, so it rides the OPE-6 bundle (a GLM
 * company classifies on glm-mini, an Anthropic company on Haiku).
 */
import { z } from "zod";
import { chat, type LlmConfig } from "./client";
import { deriveChatSignals, type Complexity, type Stakes, type TaskKind } from "./router";

export interface ChatSignals {
  taskKind: Extract<TaskKind, "owner_chat" | "owner_chat_directive">;
  complexity: Complexity;
  stakes: Stakes;
}

const Classification = z.object({
  intent: z.enum(["question", "directive"]),
  stakes: z.enum(["low", "high"]),
  complexity: z.enum(["trivial", "routine", "hard"]),
});

const SYSTEM =
  `You classify a company owner's chat message so we can pick the cheapest capable model. ` +
  `Reply ONLY with JSON: {"intent":"question"|"directive","stakes":"low"|"high","complexity":"trivial"|"routine"|"hard"}.\n` +
  `- intent "directive" = the owner is telling the company to DO something (queue work, change strategy, spend, contact someone); "question" = asking for information or an opinion.\n` +
  `- stakes "high" = acting on it would spend money, change the mission, or contact a customer; otherwise "low".\n` +
  `- complexity "hard" = needs real reasoning or trade-offs; "trivial" = a one-line answer; otherwise "routine".`;

/** Whether the cheap-model classifier is enabled. Off by default. */
export function classifierEnabled(): boolean {
  return process.env.ROUTER_CLASSIFIER === "1";
}

/**
 * Classify an owner chat message into routing signals. Uses the `mini` model when
 * enabled and configured; otherwise deterministic. Never throws — any failure
 * degrades to {@link deriveChatSignals}.
 */
export async function classifyChatSignals(cfg: LlmConfig | null, message: string): Promise<ChatSignals> {
  if (!cfg || !classifierEnabled()) return deriveChatSignals(message);
  try {
    const raw = await chat(cfg, { tier: "mini", jsonOnly: true, system: SYSTEM, user: message, maxTokens: 128 });
    const parsed = Classification.safeParse(tryJson(raw));
    if (!parsed.success) return deriveChatSignals(message);
    const c = parsed.data;
    // The classifier may only *escalate*: the deterministic `task:` directive is a
    // floor, so a weak floor model can never downgrade an explicit directive to a
    // question (observed: glm-4.5-air misreads NL directives). A directive queues
    // work → always high stakes; a question keeps the model's own stakes read.
    const directive = c.intent === "directive" || deriveChatSignals(message).taskKind === "owner_chat_directive";
    return directive
      ? { taskKind: "owner_chat_directive", complexity: c.complexity, stakes: "high" }
      : { taskKind: "owner_chat", complexity: c.complexity, stakes: c.stakes };
  } catch {
    return deriveChatSignals(message);
  }
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s.replace(/^```(?:json)?\n?|```$/g, "").trim());
  } catch {
    return null;
  }
}
