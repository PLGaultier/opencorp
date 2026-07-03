import { z } from "zod";

/**
 * Serializable worker contract (§8). The agent loop used to receive a JS closure
 * (`sandbox.run(fn)`), which only works in-process. To move the worker into an
 * isolated boundary — a child process or a hosted E2B sandbox — the unit of
 * work must cross a serialization seam: a `WorkerSpec` in, a stream of
 * `WorkerEvent`s out. The in-sandbox `agentd` runtime consumes the spec on
 * stdin and emits NDJSON events; the host pool parses them back.
 */
export const WorkerSpecSchema = z.object({
  gatewayUrl: z.string(),
  token: z.string(),
  task: z.object({ id: z.string(), title: z.string(), description: z.string() }),
  company: z.object({
    name: z.string(),
    slug: z.string(),
    mission: z.string(),
    /** Resolvable URL of the company's own published landing page (B1/B2), so the
     *  worker edits its OWN site instead of searching the public web for it. */
    siteUrl: z.string().optional(),
  }),
  budgets: z
    .object({ maxSteps: z.number().optional(), maxWallClockMs: z.number().optional() })
    .optional(),
  /** Langfuse trace id (§9.2); convention: the task id. */
  traceId: z.string().optional(),
  /**
   * Tier shift from the company's CEO "brains" level (§10): negative runs cheaper
   * models, positive runs pricier ones. 0 (default) keeps the requested tier.
   */
  tierShift: z.number().optional(),
  /** Provider family for this company's agents (OPE-6): 'anthropic' (default) | 'glm'. */
  bundle: z.enum(["anthropic", "glm"]).optional(),
  /** Curated env injected into the sandbox (LLM endpoint, etc.); secrets arrive via Infisical. */
  env: z.record(z.string()).optional(),
  /** code-mcp workspace root (§7.1); defaults to a per-task dir in the sandbox. */
  workspace: z.string().optional(),
  /** Authenticated git remote for code.git_commit_push (Forgejo deploy URL, §5.3). */
  repo: z.object({ pushUrl: z.string(), branch: z.string().optional() }).optional(),
});

export type WorkerSpec = z.infer<typeof WorkerSpecSchema>;

export function parseWorkerSpec(value: unknown): WorkerSpec {
  return WorkerSpecSchema.parse(value);
}

/** Events streamed from the sandbox back to the host, one JSON object per line. */
export type WorkerEvent =
  | { type: "step"; n: number; thought: string; tool?: string }
  | { type: "result"; summary: string; steps: number }
  | { type: "error"; message: string };

const WorkerEventSchema = z.union([
  z.object({
    type: z.literal("step"),
    n: z.number(),
    thought: z.string(),
    tool: z.string().optional(),
  }),
  z.object({ type: z.literal("result"), summary: z.string(), steps: z.number() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

/**
 * Parse one NDJSON line into a `WorkerEvent`. Lenient by design: stray stdout
 * from inside the sandbox (a stray console.log, a library banner) is not a valid
 * event and is skipped rather than corrupting the stream.
 */
export function parseWorkerEventLine(line: string): WorkerEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const parsed = WorkerEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
