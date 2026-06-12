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
 * Reassemble NDJSON lines from arbitrarily-chunked text. Transports don't
 * deliver tidy lines — a pipe read or an E2B `onStdout` callback can split one
 * event across chunks or pack several into one — so every transport funnels its
 * chunks through here before `WorkerEventSink`.
 */
export class LineBuffer {
  private buffer = "";

  constructor(private onLine: (line: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.onLine(line);
    }
  }

  /** Emit any unterminated tail once the stream is known to be finished. */
  flush(): void {
    if (this.buffer.trim()) this.onLine(this.buffer);
    this.buffer = "";
  }
}

/**
 * Split a byte stream into trimmed lines, invoking `onLine` per newline. Used to
 * pump a child process's stdout through `WorkerEventSink`.
 */
export async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const lines = new LineBuffer(onLine);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    lines.push(decoder.decode(value, { stream: true }));
  }
  lines.flush();
}
