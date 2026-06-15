import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * In-sandbox code tools (§7.1 code-mcp). Unlike the other capability servers —
 * which run gateway-side against shared infra — these run *here*, inside the
 * worker's own sandbox, against its filesystem and shell. In an E2B microVM
 * that's the VM; in the subprocess/local pools it's the worker process's cwd.
 * The agent loop still routes every call through the gateway first for
 * authz + rate-limit + audit (§7), then executes it here.
 *
 * All file paths are confined to the workspace root — a tool cannot read or
 * write outside it — and exec/output are hard-capped, independent of the task's
 * wall-clock and step budgets.
 */
const MAX_OUTPUT = 64 * 1024; // per stream
const MAX_FILE_READ = 256 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const MAX_EXEC_TIMEOUT_MS = 300_000;

export interface CodeRunnerOptions {
  /** Workspace root; created if absent. Defaults to a per-task temp dir. */
  workspace?: string;
  taskId?: string;
  /** Authenticated git remote for git_commit_push (e.g. Forgejo deploy URL). */
  gitRemote?: string;
  gitBranch?: string;
}

export type CodeToolName = "exec" | "read_file" | "write_file" | "list_files" | "git_commit_push";

export class CodeRunner {
  readonly root: string;
  private ready = false;
  constructor(private opts: CodeRunnerOptions = {}) {
    this.root = path.resolve(
      opts.workspace ?? path.join(os.tmpdir(), `opencorp-ws-${opts.taskId ?? "task"}`),
    );
  }

  /** Dispatch a validated code tool (args already checked by the gateway). */
  async run(tool: CodeToolName, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureWorkspace();
    switch (tool) {
      case "exec":
        return this.exec(String(args.command), args.timeoutMs as number | undefined);
      case "write_file":
        return this.writeFile(String(args.path), String(args.content));
      case "read_file":
        return this.readFile(String(args.path));
      case "list_files":
        return this.listFiles(args.dir as string | undefined);
      case "git_commit_push":
        return this.gitCommitPush(String(args.message));
      default:
        return { ok: false, error: "unknown_code_tool", tool };
    }
  }

  private async ensureWorkspace(): Promise<void> {
    if (this.ready) return;
    await mkdir(this.root, { recursive: true });
    this.ready = true;
  }

  /** Resolve a caller path inside the workspace; reject any escape. */
  private resolve(p: string): string {
    const abs = path.resolve(this.root, p);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error("path_escapes_workspace");
    }
    return abs;
  }

  private async exec(command: string, timeoutMs?: number): Promise<Record<string, unknown>> {
    const timeout = Math.min(timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS);
    const proc = Bun.spawn({
      cmd: ["bash", "-lc", command],
      cwd: this.root,
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill(9);
    }, timeout);
    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      return {
        ok: !timedOut && exitCode === 0,
        exitCode: timedOut ? null : exitCode,
        timedOut,
        stdout: cap(stdout),
        stderr: cap(stderr),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async writeFile(p: string, content: string): Promise<Record<string, unknown>> {
    const abs = this.resolve(p);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    return { ok: true, path: path.relative(this.root, abs), bytes: Buffer.byteLength(content) };
  }

  private async readFile(p: string): Promise<Record<string, unknown>> {
    const abs = this.resolve(p);
    if (!existsSync(abs)) return { ok: false, error: "not_found", path: p };
    const buf = await readFile(abs);
    return {
      ok: true,
      path: path.relative(this.root, abs),
      truncated: buf.length > MAX_FILE_READ,
      content: buf.subarray(0, MAX_FILE_READ).toString("utf8"),
    };
  }

  private async listFiles(dir?: string): Promise<Record<string, unknown>> {
    const abs = this.resolve(dir ?? ".");
    if (!existsSync(abs)) return { ok: false, error: "not_found", dir: dir ?? "." };
    const names = await readdir(abs);
    const entries = await Promise.all(
      names.map(async (name) => {
        const s = await stat(path.join(abs, name));
        return { name, type: s.isDirectory() ? "dir" : "file", size: s.size };
      }),
    );
    return { ok: true, dir: path.relative(this.root, abs) || ".", entries };
  }

  private async gitCommitPush(message: string): Promise<Record<string, unknown>> {
    if (!existsSync(path.join(this.root, ".git"))) {
      await this.git(["init", "-q"]);
      await this.git(["config", "user.email", "agent@opencorp.app"]);
      await this.git(["config", "user.name", "OpenCorp Worker"]);
    }
    await this.git(["add", "-A"]);
    const commit = await this.git(["commit", "-m", message]);
    if (!commit.ok && /nothing to commit/i.test(commit.stderr + commit.stdout)) {
      return { ok: true, committed: false, pushed: false, reason: "nothing_to_commit" };
    }
    if (!commit.ok) return { ok: false, error: "commit_failed", detail: cap(commit.stderr) };
    const sha = (await this.git(["rev-parse", "HEAD"])).stdout.trim();

    if (!this.opts.gitRemote) {
      return { ok: true, committed: true, pushed: false, sha, reason: "no_remote_configured" };
    }
    const branch = this.opts.gitBranch ?? "main";
    await this.git(["remote", "remove", "origin"]).catch(() => undefined);
    await this.git(["remote", "add", "origin", this.opts.gitRemote]);
    const push = await this.git(["push", "-u", "origin", `HEAD:${branch}`]);
    return push.ok
      ? { ok: true, committed: true, pushed: true, sha, branch }
      : { ok: false, committed: true, pushed: false, sha, error: "push_failed", detail: cap(push.stderr) };
  }

  private async git(argv: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const proc = Bun.spawn({ cmd: ["git", ...argv], cwd: this.root, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { ok: code === 0, stdout, stderr };
  }
}

function cap(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n…[truncated ${s.length - MAX_OUTPUT} bytes]` : s;
}
