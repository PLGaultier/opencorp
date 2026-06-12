import { parseWorkerEventLine, type WorkerTaskResult } from "@opencorp/agentd";
import type { OnStep } from "./pool";

/**
 * Collects the NDJSON event stream coming back from an isolated sandbox
 * (subprocess pipe or microVM vsock) and reconstructs the `WorkerTaskResult` —
 * the inverse of what `runWorkerRuntime` emits. Steps are forwarded live to the
 * host's `onStep` (Temporal heartbeat + ledger event); the terminal `result` or
 * `error` event decides the outcome.
 */
export class WorkerEventSink {
  private result: WorkerTaskResult | null = null;
  private errorMessage: string | null = null;

  constructor(private onStep?: OnStep) {}

  /** Feed one raw line from the sandbox's stdout/vsock. Non-event lines are ignored. */
  feed(line: string): void {
    const event = parseWorkerEventLine(line);
    if (!event) return;
    if (event.type === "step") {
      this.onStep?.({ n: event.n, thought: event.thought, tool: event.tool });
    } else if (event.type === "result") {
      this.result = { summary: event.summary, steps: event.steps };
    } else {
      this.errorMessage = event.message;
    }
  }

  /** Resolve the run. An `error` event rethrows in the host so TaskRun refunds (§5.3). */
  finish(context: string): WorkerTaskResult {
    if (this.errorMessage) throw new Error(this.errorMessage);
    if (this.result) return this.result;
    throw new Error(`sandbox produced no result (${context})`);
  }
}

/**
 * Split a byte stream into trimmed lines, invoking `onLine` per newline. Used to
 * pump a child process's stdout or a vsock connection through `WorkerEventSink`.
 */
export async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) onLine(line);
    }
  }
  if (buffer.trim()) onLine(buffer);
}
