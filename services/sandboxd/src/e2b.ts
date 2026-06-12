import { Sandbox as E2bCloudSandbox, type CommandExitError } from "e2b";
import type { WorkerSpec, WorkerTaskResult } from "@opencorp/agentd";
import { CapacityGate, type OnStep, type Sandbox, type SandboxPool, type SandboxSpec } from "./pool";
import { WorkerEventSink, LineBuffer } from "./events";
import { resolveAgentdEntry } from "./subprocess";

/**
 * E2B sandbox pool (§8). One hosted microVM per task on e2b.dev: E2B owns the
 * Firecracker fleet (boot, snapshots, networking, garbage collection); we own
 * only the data path, which is identical to the subprocess pool — a `WorkerSpec`
 * in, NDJSON `WorkerEvent`s out. The spec lands as a file and agentd runs with
 * its stdin redirected from it, so the agent loop's stdin/stdout contract is
 * byte-for-byte unchanged.
 *
 * agentd itself is not baked into the E2B template (only Bun + system deps are,
 * see infra/e2b): the pool bundles the in-repo agentd once per process and
 * uploads it at claim time, so the worker version always matches the repo.
 *
 * The host transport is injected so the pool's lifecycle logic is testable
 * without an E2B account; the real `CloudE2bHost` requires E2B_API_KEY.
 */
export interface E2bCommandOptions {
  /** Hard cap for the command; 0/undefined leaves only the sandbox lifetime cap. */
  timeoutMs?: number;
  envs?: Record<string, string>;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface E2bSandboxHandle {
  readonly id: string;
  writeFiles(files: { path: string; data: string }[]): Promise<void>;
  /** Resolves with the exit code even when non-zero; agentd exits 1 on error events. */
  runCommand(cmd: string, opts: E2bCommandOptions): Promise<{ exitCode: number }>;
  /** Tear the sandbox down. Never reused (§5.3). */
  kill(): Promise<void>;
}

export interface E2bCreateOptions {
  template: string;
  /** Sandbox lifetime; E2B garbage-collects past this even if we crash. */
  timeoutMs: number;
  metadata?: Record<string, string>;
}

export interface E2bHost {
  createSandbox(opts: E2bCreateOptions): Promise<E2bSandboxHandle>;
}

/** Where the per-task payload lands inside the sandbox (E2B user home). */
const SPEC_PATH = "/home/user/spec.json";
const AGENTD_PATH = "/home/user/agentd.js";
/** Matches the TaskRun wall clock (§5.3) when a claim carries no budget. */
const DEFAULT_WALL_CLOCK_MS = 1_800_000;
/** Grace past the wall clock before E2B's own reaper kills the sandbox. */
const SANDBOX_LIFETIME_GRACE_MS = 60_000;

/**
 * The worker runs in E2B's cloud, so every URL it must reach (MCP gateway, LLM
 * proxy) has to be publicly routable — loopback means a guaranteed hang.
 */
function assertReachableFromCloud(spec: WorkerSpec): void {
  const urls = [spec.gatewayUrl, spec.env?.LITELLM_URL];
  for (const url of urls) {
    if (!url) continue;
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      continue;
    }
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "0.0.0.0" ||
      hostname.endsWith(".localhost")
    ) {
      throw new Error(
        `e2b_requires_public_gateway_url: ${url} is not reachable from an E2B sandbox ` +
          "(for a local smoke test, expose it with `cloudflared tunnel --url http://localhost:3004`)",
      );
    }
  }
}

class E2bSandbox implements Sandbox {
  readonly id: string;
  private released = false;
  private used = false;

  constructor(
    private handle: E2bSandboxHandle,
    private bundle: string,
    private budgets: SandboxSpec["budgets"],
    private onRelease: () => void,
  ) {
    this.id = `e2b-${handle.id}`;
  }

  async execAgent(spec: WorkerSpec, onStep?: OnStep): Promise<WorkerTaskResult> {
    if (this.released) throw new Error("sandbox_already_released");
    if (this.used) throw new Error("sandbox_already_used"); // one task per sandbox (§5.3)
    this.used = true;
    assertReachableFromCloud(spec);

    // Hard wall-clock cap, enforced by killing the sandbox — never the prompt (§5.3).
    const wall = this.budgets?.maxWallClockMs ?? spec.budgets?.maxWallClockMs;
    let timedOut = false;
    const timer = wall
      ? setTimeout(() => {
          timedOut = true;
          void this.handle.kill();
        }, wall)
      : null;

    const sink = new WorkerEventSink(onStep);
    const lines = new LineBuffer((line) => sink.feed(line));
    try {
      await this.handle.writeFiles([
        { path: SPEC_PATH, data: JSON.stringify(spec) },
        { path: AGENTD_PATH, data: this.bundle },
      ]);
      let exitCode: number;
      try {
        // stdin redirect preserves agentd's read-spec-from-stdin contract; the
        // command-level timeout is the second enforcement layer behind our timer.
        const res = await this.handle.runCommand(`bun ${AGENTD_PATH} < ${SPEC_PATH}`, {
          timeoutMs: wall,
          envs: spec.env,
          onStdout: (chunk) => lines.push(chunk),
        });
        exitCode = res.exitCode;
      } catch (err) {
        // Killing the sandbox mid-command surfaces as a transport error.
        if (timedOut) throw new Error("wall_clock_budget_exceeded");
        throw err;
      }
      lines.flush();
      if (timedOut) throw new Error("wall_clock_budget_exceeded");
      return sink.finish(`e2b sandbox ${this.handle.id} exited with code ${exitCode}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async run<T>(): Promise<T> {
    // The closure escape hatch only makes sense in-process; a hosted sandbox
    // cannot receive a host closure across the network boundary.
    throw new Error("e2b_sandbox_requires_execAgent");
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.handle.kill().catch(() => {}); // E2B's reaper is the backstop
    this.onRelease();
  }
}

export interface E2bPoolOptions {
  capacity?: number;
  /** E2B template name or ID; built from infra/e2b (Bun + system deps only). */
  templateId?: string;
  /** Injected transport; defaults to the real E2B cloud host. */
  host?: E2bHost;
  /** Path to the agentd entry to bundle; same resolution as the subprocess pool. */
  agentdEntry?: string;
}

/**
 * Single-file agentd bundle, built once per process per entry and reused across
 * pools and claims (module-level: repeated `Bun.build` calls also misbehave
 * under the bun test runner).
 */
const bundleCache = new Map<string, Promise<string>>();
function bundleAgentd(entry: string): Promise<string> {
  let bundle = bundleCache.get(entry);
  if (!bundle) {
    bundle = (async () => {
      const result = await Bun.build({ entrypoints: [entry], target: "bun" });
      if (!result.success || !result.outputs[0]) {
        throw new Error(`agentd_bundle_failed: ${result.logs.join("; ")}`);
      }
      return result.outputs[0].text();
    })();
    bundleCache.set(entry, bundle);
  }
  return bundle;
}

export class E2bSandboxPool implements SandboxPool {
  readonly kind = "e2b";
  private gate: CapacityGate;
  private host: E2bHost;
  private templateId: string;
  private entry: string;

  constructor(opts: E2bPoolOptions = {}) {
    // Default stays under E2B's 20-concurrent-sandbox Hobby plan limit.
    this.gate = new CapacityGate(opts.capacity ?? 16);
    this.templateId = opts.templateId ?? process.env.E2B_TEMPLATE_ID ?? "opencorp-agentd";
    this.host = opts.host ?? new CloudE2bHost();
    this.entry = resolveAgentdEntry(opts.agentdEntry);
  }

  async claim(spec: SandboxSpec): Promise<Sandbox> {
    await this.gate.acquire();
    try {
      const wall = spec.budgets?.maxWallClockMs ?? DEFAULT_WALL_CLOCK_MS;
      const [bundle, handle] = await Promise.all([
        bundleAgentd(this.entry),
        this.host.createSandbox({
          template: this.templateId,
          timeoutMs: wall + SANDBOX_LIFETIME_GRACE_MS,
          metadata: { taskId: spec.taskId, companyId: spec.companyId },
        }),
      ]);
      return new E2bSandbox(handle, bundle, spec.budgets, () => this.gate.release());
    } catch (err) {
      this.gate.release();
      throw err;
    }
  }

  stats() {
    return this.gate.stats(this.kind);
  }
}

/** Real E2B cloud transport. Construction fails fast without an API key. */
export class CloudE2bHost implements E2bHost {
  constructor() {
    if (!process.env.E2B_API_KEY) {
      throw new Error(
        "e2b_api_key_missing: SANDBOX_KIND=e2b requires E2B_API_KEY (https://e2b.dev/dashboard)",
      );
    }
  }

  async createSandbox(opts: E2bCreateOptions): Promise<E2bSandboxHandle> {
    const sandbox = await E2bCloudSandbox.create(opts.template, {
      timeoutMs: opts.timeoutMs,
      metadata: opts.metadata,
    });
    return {
      id: sandbox.sandboxId,
      async writeFiles(files) {
        await sandbox.files.write(files);
      },
      async runCommand(cmd, o) {
        try {
          const result = await sandbox.commands.run(cmd, {
            timeoutMs: o.timeoutMs ?? 0, // 0 disables the SDK's 60 s default
            envs: o.envs,
            onStdout: o.onStdout,
            onStderr: o.onStderr,
          });
          return { exitCode: result.exitCode };
        } catch (err) {
          // agentd exits 1 after emitting an error event — that's a normal
          // outcome for the sink to interpret, not a transport failure.
          const exitCode = (err as CommandExitError).exitCode;
          if (typeof exitCode === "number") return { exitCode };
          throw err;
        }
      },
      async kill() {
        await sandbox.kill();
      },
    };
  }
}
