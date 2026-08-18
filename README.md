# OpenCorp

**Self-hostable platform for autonomous, AI-run companies.**

Write one prompt (*"a tiny SaaS that summarizes PDFs"*) and OpenCorp spins up a
company: a mission, a CEO agent that plans, worker agents that write code, ship a
website, send email, and take payments — all running on a daily schedule with no
human in the loop.

Every move is **radically transparent**: each agent decision, tool call, token
spent, and cent earned lands on a public, hash-chained ledger you can verify
independently.

> **Status:** paused since 2026-08-18 — the production instance has been shut
> down and the hosting retired. The frozen ledger (4353 verified events) and the
> full shutdown/resume runbook are in [PAUSE.md](./PAUSE.md). Source is published
> for evaluation and self-hosting — see [License](#license).

Full technical spec: [OPENCORP_SPEC.md](./OPENCORP_SPEC.md).

## How it works

- **One-prompt companies** — `POST /companies` provisions a mission, CEO, DB,
  site, and email via a Temporal workflow.
- **CEO + departments** — every heartbeat, CMO/CTO/CFO sub-planners review the
  company through their own lens; the CEO synthesizes their proposals into a plan.
- **Autonomous worker tasks** — the CEO delegates tasks to workers that run in
  isolated sandboxes, one at a time per company, under daily and spend caps.
- **Daily heartbeats** — each company runs on its own cron schedule; owners can
  pause/resume but the company otherwise runs itself.
- **Verifiable ledger** — `hash = SHA-256(prev_hash ‖ canonical_json(payload) ‖ seq ‖ created_at)`,
  secrets redacted first. `bun run ledger:verify` recomputes the chain.

## Layout

```
apps/api          Bun + Hono REST API + auth (Better Auth)
apps/web          Dashboard (deployed on Vercel)
apps/gateway      LLM gateway (spend limits, prompt-injection containment)
services/agentd   Agent runtime — CEO planning + worker task execution
services/ledgerd  Append-only hash-chained ledger + verify CLI
services/deployd  Per-company website deploys
services/sandboxd Sandboxed code execution (local pool or E2B microVMs)
packages/schema   Drizzle schema (Postgres 17 + pgvector)
prompts/          Versioned agent prompts (CEO, dept_*, design)
infra/compose     Local + prod Docker stacks (PG, Valkey, Temporal, LiteLLM)
```

## Try it locally

Everything runs on **your own machine** — your Anthropic key, your Docker, your
data. No accounts to create.

**Prerequisites:** [Bun](https://bun.sh) and Docker Desktop (running).

```bash
git clone https://github.com/PLGaultier/opencorp.git && cd opencorp
bun install
cp .env.example .env       # optional: add your own ANTHROPIC_API_KEY
bun run dev                # brings up Postgres + Temporal, migrates, launches everything
```

Then open the **Dashboard** at http://localhost:3000 (API on `:3001`, Temporal UI
on `:8233`) and create your first company:

```bash
curl -XPOST localhost:3001/companies -H 'content-type: application/json' \
  -d '{"prompt":"a tiny SaaS that summarizes PDFs"}'
```

**No key needed to look around.** With an `ANTHROPIC_API_KEY`, agents think with a
real model (billed to *your* key). Leave it blank and the whole stack still runs
end-to-end in a deterministic offline mode. Every other integration (GitHub auth,
email, payments, ads, cloud sandboxes) is off by default and falls back to a local
mock.

## Developing

```bash
bun test              # full suite, incl. the ledger chain-verify test (10k events)
bun run ledger:verify # recompute the ledger hash-chain against Postgres
```

## Self-host on a server

To run a real, reachable instance (single VPS + Docker Compose + Caddy, dashboard
on Vercel, real GitHub auth + LLM), see **[DEPLOY.md](./DEPLOY.md)** for the full
walkthrough (DNS, TLS, backups, spend kill-switch). The short version:

```sh
cp .env.prod.example .env.prod    # set your domain, secrets, ANTHROPIC_API_KEY, GitHub OAuth
docker compose -f infra/compose/docker-compose.prod.yml --env-file .env.prod up -d --build
```

The sandbox starts in `local` mode (agent code runs in the worker container). Flip
`SANDBOX_KIND=e2b` for real microVM isolation before exposing it to untrusted use.

## License

**Not yet licensed — all rights reserved.** The source is published so you can read
it, run it locally, and self-host it for **evaluation and personal use**. It is
**not** open source under the OSI definition (yet). For commercial or production
use, please ask first.
