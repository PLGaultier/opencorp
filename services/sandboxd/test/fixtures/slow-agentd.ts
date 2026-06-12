// Test fixture standing in for agentd's main: reads the spec, then sleeps well
// past any sane wall-clock budget. Used to prove the subprocess pool kills a
// runaway worker rather than waiting for it.
export {};
await Bun.stdin.text();
await new Promise((r) => setTimeout(r, 10_000));
process.stdout.write(JSON.stringify({ type: "result", summary: "too late", steps: 1 }) + "\n");
