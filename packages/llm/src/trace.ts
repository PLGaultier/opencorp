import { randomUUID } from "node:crypto";

/**
 * Langfuse trace emitter (§9.2): every LLM generation in a task is recorded
 * against a trace whose id is the task id, marked `public: true` so the
 * public company page can link straight to the full trace without a login.
 * Speaks the Langfuse batch ingestion API directly — no SDK dependency —
 * and degrades to a no-op when LANGFUSE_* env is unset (dev/tests/self-host
 * without observability).
 */

export interface TraceConfig {
  host: string; // e.g. https://langfuse.opencorp.app
  publicKey: string;
  secretKey: string;
  /** Needed to build public trace URLs; without it traces are still recorded. */
  projectId?: string;
}

export function traceConfigFromEnv(): TraceConfig | null {
  const host = process.env.LANGFUSE_HOST;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!host || !publicKey || !secretKey) return null;
  return { host, publicKey, secretKey, projectId: process.env.LANGFUSE_PROJECT_ID };
}

export function publicTraceUrl(cfg: Pick<TraceConfig, "host" | "projectId">, traceId: string): string | null {
  if (!cfg.projectId) return null;
  return `${cfg.host.replace(/\/$/, "")}/project/${cfg.projectId}/traces/${traceId}`;
}

export interface GenerationRecord {
  traceId: string;
  name: string;
  model: string;
  input: unknown;
  output: unknown;
  usage?: { input: number; output: number };
  startTime: Date;
  endTime: Date;
}

interface IngestionEvent {
  id: string;
  type: "trace-create" | "generation-create";
  timestamp: string;
  body: Record<string, unknown>;
}

export class Tracer {
  private queue: IngestionEvent[] = [];
  private tracesCreated = new Set<string>();

  constructor(
    private cfg: TraceConfig,
    private fetchFn: typeof fetch = fetch,
  ) {}

  /** Queue a generation (and the trace-create on first sight). Call flush() to send. */
  generation(rec: GenerationRecord): void {
    const ts = rec.endTime.toISOString();
    if (!this.tracesCreated.has(rec.traceId)) {
      this.tracesCreated.add(rec.traceId);
      this.queue.push({
        id: randomUUID(),
        type: "trace-create",
        timestamp: rec.startTime.toISOString(),
        body: { id: rec.traceId, name: rec.traceId, public: true },
      });
    }
    this.queue.push({
      id: randomUUID(),
      type: "generation-create",
      timestamp: ts,
      body: {
        id: randomUUID(),
        traceId: rec.traceId,
        name: rec.name,
        model: rec.model,
        input: rec.input,
        output: rec.output,
        ...(rec.usage ? { usage: rec.usage } : {}),
        startTime: rec.startTime.toISOString(),
        endTime: ts,
      },
    });
  }

  /** Best-effort batch send; tracing must never fail a task. */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    const auth = Buffer.from(`${this.cfg.publicKey}:${this.cfg.secretKey}`).toString("base64");
    try {
      await this.fetchFn(`${this.cfg.host.replace(/\/$/, "")}/api/public/ingestion`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
        body: JSON.stringify({ batch }),
      });
    } catch {
      /* observability outage must not break execution */
    }
  }

  publicUrl(traceId: string): string | null {
    return publicTraceUrl(this.cfg, traceId);
  }
}

export function tracerFromEnv(): Tracer | null {
  const cfg = traceConfigFromEnv();
  return cfg ? new Tracer(cfg) : null;
}
