# E2B worker template

Worker agents run one-per-task in [E2B](https://e2b.dev) hosted sandboxes
(`SANDBOX_KIND=e2b`, §8). This directory holds the sandbox template: a Debian
base image with Bun and a few system tools. **agentd is not baked in** — the
pool bundles the in-repo agentd (`Bun.build`) and uploads it at claim time, so
the worker version always matches the repo and the template almost never needs
rebuilding.

## Build the template

```sh
npm i -g @e2b/cli       # once
e2b auth login          # once
e2b template build --name opencorp-agentd --dockerfile infra/e2b/e2b.Dockerfile
```

Rebuild only when system dependencies change (Bun version, apt packages).

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
