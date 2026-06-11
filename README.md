# OpenCorp

Open-source, self-hostable platform for autonomous AI-run companies with
**radical transparency**: every agent decision, tool call, token spent, and
cent earned lands on a public, hash-chained ledger.

Full spec: [OPENCORP_SPEC.md](./OPENCORP_SPEC.md). Current milestone: **M5 — Frontier (in progress)**:
- **Multi-agent departments** — every heartbeat, CMO/CTO/CFO sub-planners (`prompts/dept_*.md`) review the company through their own lens and publish `department_plan` proposals to the ledger; the CEO synthesizes them into the final plan.
- **Autonomous heartbeats** — every company gets a per-company Temporal Schedule (daily cron, `HEARTBEAT_CRON`) created at provisioning; pause/resume are owner-only API controls (`POST /companies/:id/pause|resume`), and `POST /admin/schedules/backfill` migrates pre-existing companies. Companies now run with zero human involvement — the §16 "daily autonomous task runs" requirement.

## Layout

```
apps/api            Bun + Hono REST API (/api/ledger, /api/ledger/verify)
services/ledgerd    Append-only hash-chained ledger + redaction + verify CLI
packages/schema     Drizzle schema for the control DB (Postgres 17 + pgvector)
infra/compose       Local dev stack (PG, Valkey, Temporal, MinIO, LiteLLM)
prompts/            Versioned agent prompts
```

## Quick start

```bash
bun install
bun test                          # includes the M0 exit test: 10k events, chain verifies

# full dev stack (requires Docker)
docker compose -f infra/compose/docker-compose.dev.yml up -d
bun run db:generate && bun run db:migrate
bun run dev:api                   # http://localhost:3001/healthz

# verify the ledger chain against Postgres
bun run ledger:verify
```

## Ledger design (§9 of the spec)

Each event: `hash = SHA-256(prev_hash ‖ canonical_json(payload) ‖ seq ‖ created_at)`.
Payloads pass a versioned redactor first (secrets stripped, third-party emails
hashed). `bun run ledger:verify` recomputes the chain and reports the first
broken seq, if any.

## Threat model & honest limits

See §15 of the spec: prompt injection containment at the gateway, outbound
email throttles, no claim of legal entity creation, payments stay a pluggable
adapter (Stripe Connect default).
