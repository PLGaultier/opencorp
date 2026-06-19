import { runWorkerTask } from "./loop";
import type { WorkerSpec, WorkerEvent } from "./spec";

/**
 * In-sandbox runtime (§8). Drives the ReAct loop from a serializable spec and
 * reports back purely as `WorkerEvent`s — no shared memory, no closure. This is
 * the boundary that lets the identical agent loop run in-process, in a child
 * process, or inside a hosted E2B sandbox unchanged.
 *
 * It never throws: a thrown loop (budget exceeded, gateway down) is reported as
 * a terminal `error` event so the host always sees a clean end-of-stream.
 */
export async function runWorkerRuntime(
  spec: WorkerSpec,
  emit: (event: WorkerEvent) => void,
): Promise<void> {
  try {
    const result = await runWorkerTask({
      gatewayUrl: spec.gatewayUrl,
      token: spec.token,
      task: spec.task,
      company: spec.company,
      budgets: spec.budgets,
      traceId: spec.traceId,
      tierShift: spec.tierShift,
      onStep: (step) => emit({ type: "step", ...step }),
    });
    emit({ type: "result", summary: result.summary, steps: result.steps });
  } catch (err) {
    emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}
