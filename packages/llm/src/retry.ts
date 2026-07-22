// A transient LLM failure is a per-call blip, not a reason to fail the whole
// task: z.ai/GLM occasionally returns an empty completion (even with reasoning
// disabled), and the fetch to LiteLLM can flake (undici headers timeout, reset
// socket, 429/5xx). Without a retry, one blip kills the entire heartbeat task —
// seen in prod as `llm returned empty completion` and `HeadersTimeoutError`.
// Anything else (400/401 bad request, auth) is not transient and rethrows at once.
export const TRANSIENT_LLM =
  /empty completion|fetch failed|headers timeout|UND_ERR|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|\b(?:429|502|503|504)\b/i;

/** True for errors worth retrying (empty completion, network flake, 429/5xx). */
export function isTransientLlmError(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } })?.cause?.code ?? "";
  const msg = err instanceof Error ? `${err.message} ${cause}` : String(err);
  return TRANSIENT_LLM.test(msg);
}

/**
 * Retry a single LLM call over transient failures. Non-transient errors
 * (400/401) rethrow immediately. `sleep` is injectable so tests don't wait on
 * real backoff.
 *
 * Every LLM entry point that a heartbeat depends on must go through this. The
 * worker loop has since 2026-07-18 (§5.3); CEO planning did not, and prod lost
 * whole days to it — `ceo_plan` produced 0 plans on 2026-07-19 and 2026-07-22
 * because a single empty completion escaped planHeartbeat uncaught.
 */
export async function withLlmRetry<T>(
  call: () => Promise<T>,
  attempts = Number(process.env.WORKER_LLM_RETRIES ?? 3),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await call();
    } catch (err) {
      if (i >= attempts - 1 || !isTransientLlmError(err)) throw err;
      // 300ms → 600ms → 1200ms … with jitter, so a brief upstream blip clears.
      await sleep(300 * 2 ** i + Math.random() * 150);
    }
  }
}
