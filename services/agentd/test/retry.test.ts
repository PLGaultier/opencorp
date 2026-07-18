import { describe, expect, test } from "bun:test";
import { isTransientLlmError, withLlmRetry } from "../src/loop";

/**
 * Transient-LLM retry (§5.3): a single empty completion or network flake from
 * z.ai/LiteLLM must not fail the whole heartbeat task. Backoff sleep is stubbed
 * so these run instantly.
 */
const noSleep = () => Promise.resolve();

describe("isTransientLlmError", () => {
  test("classifies empty completion + network flakes as transient", () => {
    expect(isTransientLlmError(new Error("llm returned empty completion"))).toBe(true);
    expect(isTransientLlmError(Object.assign(new Error("fetch failed"), {
      cause: { code: "UND_ERR_HEADERS_TIMEOUT" },
    }))).toBe(true);
    expect(isTransientLlmError(new Error("llm glm-4.7 failed: 503 upstream"))).toBe(true);
    expect(isTransientLlmError(new Error("llm glm-4.7 failed: 429 rate limited"))).toBe(true);
  });

  test("does not retry genuine client errors", () => {
    expect(isTransientLlmError(new Error("llm glm-4.7 failed: 400 bad request"))).toBe(false);
    expect(isTransientLlmError(new Error("llm glm-4.7 failed: 401 unauthorized"))).toBe(false);
  });
});

describe("withLlmRetry", () => {
  test("recovers after transient failures then succeeds", async () => {
    let calls = 0;
    const result = await withLlmRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("llm returned empty completion");
        return "ok";
      },
      3,
      noSleep,
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  test("gives up after exhausting attempts and rethrows the last error", async () => {
    let calls = 0;
    const run = withLlmRetry(
      async () => {
        calls++;
        throw new Error("llm returned empty completion");
      },
      3,
      noSleep,
    );
    await expect(run).rejects.toThrow("empty completion");
    expect(calls).toBe(3);
  });

  test("does not retry a non-transient error", async () => {
    let calls = 0;
    const run = withLlmRetry(
      async () => {
        calls++;
        throw new Error("llm glm-4.7 failed: 400 bad request");
      },
      3,
      noSleep,
    );
    await expect(run).rejects.toThrow("400");
    expect(calls).toBe(1);
  });
});
