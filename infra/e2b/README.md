# E2B worker template

Worker agents run one-per-task in [E2B](https://e2b.dev) hosted sandboxes
(`SANDBOX_KIND=e2b`, §8). This directory holds the sandbox template: a Debian
base image with Bun and a few system tools. **agentd is not baked in** — the
pool bundles the in-repo agentd (`Bun.build`) and uploads it at claim time, so
the worker version always matches the repo and the template almost never needs
rebuilding.

## Build the template

```sh
bunx @e2b/cli auth login                            # once
bun services/sandboxd/scripts/build-template.ts     # builds in E2B's cloud (no local Docker)
```

The script uses the v2 Template SDK (`Template.build` over this Dockerfile);
the CLI's `template build` v1 path is deprecated and silently no-ops. Rebuild
only when system dependencies change (Bun version, apt packages).

## Smoke test

```sh
bun services/sandboxd/scripts/smoke-e2b.ts opencorp-agentd
```

Runs the pool's exact data path against a real sandbox: real agentd bundle,
spec via stdin redirect, NDJSON events back — against a fake MCP gateway
started *inside* the sandbox, so no public gateway/tunnel is needed. Without
the argument it falls back to the `base` template and installs Bun at runtime.

## Runtime configuration

| Env var            | Purpose                                                        |
| ------------------ | -------------------------------------------------------------- |
| `SANDBOX_KIND=e2b` | Select the E2B pool in `createSandboxPool()`                   |
| `E2B_API_KEY`      | E2B API key (https://e2b.dev/dashboard) — required             |
| `E2B_TEMPLATE_ID`  | Template name/ID; defaults to `opencorp-agentd`                |
| `SANDBOX_CAPACITY` | Max concurrent sandboxes; defaults to 16 (Hobby plan allows 20)|

## Networking

The worker runs in E2B's cloud, so everything it calls must be **publicly
reachable**: `GATEWAY_URL` (MCP gateway) and `LITELLM_URL`. Local dev keeps
`SANDBOX_KIND=local|subprocess`; for a local end-to-end smoke test of the E2B
path, expose the gateway with a tunnel:

```sh
cloudflared tunnel --url http://localhost:3004
```

## Budgets

Wall clock is enforced in three layers, host authoritative: a host-side timer
kills the sandbox (`wall_clock_budget_exceeded`), the command runs with the same
`timeoutMs`, and the sandbox itself is created with wall + 60 s lifetime so
E2B's reaper cleans up even if sandboxd crashes. A 30-minute task costs roughly
$0.06 at E2B's pay-per-second pricing.
