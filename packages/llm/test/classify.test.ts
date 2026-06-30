import { afterEach, describe, expect, test } from "bun:test";
import { classifyChatSignals, classifierEnabled } from "../src/classify";
import type { LlmConfig } from "../src/client";

const ENABLE = () => (process.env.ROUTER_CLASSIFIER = "1");
afterEach(() => {
  delete process.env.ROUTER_CLASSIFIER;
});

/** A LiteLLM stub returning a fixed chat-completions body. */
function stubServer(body: unknown) {
  return Bun.serve({
    port: 0,
    fetch: () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
  });
}
const completion = (content: string) => ({ choices: [{ message: { content } }], model: "mini" });

describe("classifyChatSignals (OPE-7b)", () => {
  test("classifierEnabled reflects the env flag", () => {
    expect(classifierEnabled()).toBe(false);
    ENABLE();
    expect(classifierEnabled()).toBe(true);
  });

  test("off by default → deterministic (identical to deriveChatSignals)", async () => {
    expect(await classifyChatSignals({ baseUrl: "http://unused" }, "What's our runway?")).toEqual({
      taskKind: "owner_chat",
      complexity: "routine",
      stakes: "low",
    });
    expect(await classifyChatSignals({ baseUrl: "http://unused" }, "task: ship pricing")).toEqual({
      taskKind: "owner_chat_directive",
      complexity: "routine",
      stakes: "high",
    });
  });

  test("null cfg → deterministic even when enabled", async () => {
    ENABLE();
    expect(await classifyChatSignals(null, "anything")).toEqual({
      taskKind: "owner_chat",
      complexity: "routine",
      stakes: "low",
    });
  });

  test("enabled → maps a model directive classification to high-stakes directive", async () => {
    ENABLE();
    const srv = stubServer(completion('{"intent":"directive","stakes":"low","complexity":"hard"}'));
    try {
      const cfg: LlmConfig = { baseUrl: srv.url.origin };
      // intent=directive forces high stakes regardless of the model's stakes field
      expect(await classifyChatSignals(cfg, "please raise prices 20%")).toEqual({
        taskKind: "owner_chat_directive",
        complexity: "hard",
        stakes: "high",
      });
    } finally {
      srv.stop(true);
    }
  });

  test("enabled → a question keeps the model's stakes read", async () => {
    ENABLE();
    const srv = stubServer(completion('{"intent":"question","stakes":"high","complexity":"routine"}'));
    try {
      expect(await classifyChatSignals({ baseUrl: srv.url.origin }, "should we bet the budget on ads?")).toEqual({
        taskKind: "owner_chat",
        complexity: "routine",
        stakes: "high",
      });
    } finally {
      srv.stop(true);
    }
  });

  test("classifier can only escalate: a model misread can't downgrade an explicit 'task:' directive", async () => {
    ENABLE();
    // model wrongly says "question", but the deterministic floor sees the task: prefix
    const srv = stubServer(completion('{"intent":"question","stakes":"low","complexity":"trivial"}'));
    try {
      expect(await classifyChatSignals({ baseUrl: srv.url.origin }, "task: wire the Stripe webhook")).toEqual({
        taskKind: "owner_chat_directive",
        complexity: "trivial",
        stakes: "high",
      });
    } finally {
      srv.stop(true);
    }
  });

  test("enabled but unparseable response → deterministic fallback", async () => {
    ENABLE();
    const srv = stubServer(completion("not json at all"));
    try {
      expect(await classifyChatSignals({ baseUrl: srv.url.origin }, "task: do the thing")).toEqual({
        taskKind: "owner_chat_directive",
        complexity: "routine",
        stakes: "high",
      });
    } finally {
      srv.stop(true);
    }
  });

  test("enabled but the call throws → deterministic fallback", async () => {
    ENABLE();
    // nothing listening on this port → fetch rejects → caught → fallback
    expect(await classifyChatSignals({ baseUrl: "http://127.0.0.1:1" }, "plain question")).toEqual({
      taskKind: "owner_chat",
      complexity: "routine",
      stakes: "low",
    });
  });
});
