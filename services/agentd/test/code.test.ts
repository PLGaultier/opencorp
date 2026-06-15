import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodeRunner } from "../src/code";

/**
 * code-mcp executor (§7.1): runs in the worker's sandbox against its real
 * filesystem and shell. Each test uses an isolated temp workspace.
 */
function freshRunner(remote?: string) {
  const ws = path.join(os.tmpdir(), `oc-code-test-${Math.random().toString(36).slice(2)}`);
  return { runner: new CodeRunner({ workspace: ws, gitRemote: remote }), ws };
}

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((ws) => rm(ws, { recursive: true, force: true })));
});

describe("CodeRunner file tools", () => {
  test("write → read → list round-trips in the workspace", async () => {
    const { runner, ws } = freshRunner();
    cleanups.push(ws);

    const w = await runner.run("write_file", { path: "src/app.js", content: "export const x = 1;\n" });
    expect(w).toMatchObject({ ok: true, path: "src/app.js", bytes: 20 });

    const r = await runner.run("read_file", { path: "src/app.js" });
    expect(r).toMatchObject({ ok: true, content: "export const x = 1;\n" });

    const ls = (await runner.run("list_files", { dir: "src" })) as { entries: { name: string }[] };
    expect(ls.entries.map((e) => e.name)).toEqual(["app.js"]);
  });

  test("read_file on a missing path returns not_found, not a throw", async () => {
    const { runner, ws } = freshRunner();
    cleanups.push(ws);
    expect(await runner.run("read_file", { path: "nope.txt" })).toMatchObject({ ok: false, error: "not_found" });
  });

  test("paths cannot escape the workspace", async () => {
    const { runner, ws } = freshRunner();
    cleanups.push(ws);
    await expect(runner.run("write_file", { path: "../escape.txt", content: "x" })).rejects.toThrow(
      "path_escapes_workspace",
    );
    expect(existsSync(path.join(path.dirname(ws), "escape.txt"))).toBe(false);
  });
});

describe("CodeRunner exec", () => {
  test("runs a command in the workspace and captures stdout + exit code", async () => {
    const { runner, ws } = freshRunner();
    cleanups.push(ws);
    await runner.run("write_file", { path: "data.txt", content: "a\nb\nc\n" });
    const out = (await runner.run("exec", { command: "wc -l < data.txt" })) as {
      ok: boolean; exitCode: number; stdout: string;
    };
    expect(out.ok).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe("3");
  });

  test("a non-zero exit is reported as ok:false with stderr", async () => {
    const { runner, ws } = freshRunner();
    cleanups.push(ws);
    const out = (await runner.run("exec", { command: "ls /no/such/dir" })) as { ok: boolean; exitCode: number };
    expect(out.ok).toBe(false);
    expect(out.exitCode).not.toBe(0);
  });

  test("kills a command that exceeds its timeout", async () => {
    const { runner, ws } = freshRunner();
    cleanups.push(ws);
    const out = (await runner.run("exec", { command: "sleep 10", timeoutMs: 150 })) as {
      ok: boolean; timedOut: boolean;
    };
    expect(out.timedOut).toBe(true);
    expect(out.ok).toBe(false);
  });
});

describe("CodeRunner git_commit_push", () => {
  test("inits, commits, and reports no remote when unconfigured", async () => {
    const { runner, ws } = freshRunner();
    cleanups.push(ws);
    await runner.run("write_file", { path: "README.md", content: "# hello\n" });
    const res = (await runner.run("git_commit_push", { message: "first commit" })) as {
      ok: boolean; committed: boolean; pushed: boolean; reason?: string; sha?: string;
    };
    expect(res).toMatchObject({ ok: true, committed: true, pushed: false, reason: "no_remote_configured" });
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("a second commit with no changes is a clean no-op", async () => {
    const { runner, ws } = freshRunner();
    cleanups.push(ws);
    await runner.run("write_file", { path: "a.txt", content: "1" });
    await runner.run("git_commit_push", { message: "c1" });
    const res = (await runner.run("git_commit_push", { message: "c2" })) as { committed: boolean; reason?: string };
    expect(res).toMatchObject({ committed: false, reason: "nothing_to_commit" });
  });
});
