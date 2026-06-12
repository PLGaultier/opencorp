#!/usr/bin/env bun
import { runWorkerRuntime } from "./runtime";
import { parseWorkerSpec } from "./spec";

/**
 * Entry point for the worker program that runs *inside* a sandbox (§8). Reads a
 * `WorkerSpec` as JSON on stdin and writes `WorkerEvent`s as NDJSON on stdout,
 * one per line. In an E2B sandbox the host uploads this program as a bundle and
 * runs it with stdin redirected from the spec file; in the subprocess pool the
 * host pipes stdin/stdout directly. The contract is identical either way, which
 * is the whole point of the seam.
 */
async function main(): Promise<void> {
  const raw = await Bun.stdin.text();
  if (!raw.trim()) {
    process.stdout.write(
      JSON.stringify({ type: "error", message: "no worker spec on stdin" }) + "\n",
    );
    process.exit(1);
  }

  let spec;
  try {
    spec = parseWorkerSpec(JSON.parse(raw));
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        type: "error",
        message: `invalid worker spec: ${err instanceof Error ? err.message : String(err)}`,
      }) + "\n",
    );
    process.exit(1);
  }

  let failed = false;
  await runWorkerRuntime(spec, (event) => {
    if (event.type === "error") failed = true;
    process.stdout.write(JSON.stringify(event) + "\n");
  });
  process.exit(failed ? 1 : 0);
}

void main();
