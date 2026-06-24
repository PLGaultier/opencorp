# OpenCorp

Self-hostable platform for autonomous AI-run companies with **radical
transparency**: every agent decision, tool call, token spent, and cent earned
lands on a public, hash-chained ledger.

> **Status:** source published for evaluation and self-hosting while the
> licensing model is being decided — see [License](#license) below.

Full spec: [OPENCORP_SPEC.md](./OPENCORP_SPEC.md). Current milestone: **M5 — Frontier (in progress)**:
- **Multi-agent departments** — every heartbeat, CMO/CTO/CFO sub-planners (`prompts/dept_*.md`) review the company through their own lens and publish `department_plan` proposals to the ledger; the CEO synthesizes them into the final plan.
- **Autonomous heartbeats** — every company gets a per-company Temporal Schedule (daily cron, `HEARTBEAT_CRON`) created at provisioning; pause/resume are owner-only API controls (`POST /companies/:id/pause|resume`), and `POST /admin/schedules/backfill` migrates pre-existing companies. Companies now run with zero human involvement — the §16 "daily autonomous task runs" requirement.
- **Auth** — Better Auth (email + password, §3) mounted at `/api/auth/*`; signing up creates the user's conglomerate with an owner membership. Owner/money endpoints (create company, heartbeat, pause/resume, chat, run task, withdraw, subscribe) require a session + conglomerate membership; transparency surfaces (`/api/companies`, `/api/ledger*`, `/api/live`) stay public by design (§9.2). Dashboard gets `/login` + a session badge. Dev: `OPENCORP_AUTH_DISABLED=1` bypasses auth for demo scripts.

## Layout

```
apps/api            Bun + Hono REST API (/api/ledger, /api/ledger/verify)
services/ledgerd    Append-only hash-chained ledger + redaction + verify CLI
packages/schema     Drizzle schema for the control DB (Postgres 17 + pgvector)
infra/compose       Local dev stack (PG, Valkey, Temporal, MinIO, LiteLLM)
prompts/            Versioned agent prompts
```

## Try it locally (4 commands)

Everything runs on **your own machine** — your Anthropic key, your Docker, your
data. Nothing is shared or hosted; there are no accounts to create.

**Prerequisites:** [Bun](https://bun.sh) and Docker Desktop (running).

```bash
git clone https://github.com/PLGaultier/opencorp.git && cd opencorp
bun install
cp .env.example .env       # optional: add your own ANTHROPIC_API_KEY (see below)
bun run dev                # brings up Postgres + Temporal, migrates, launches everything
```

When it's ready, open:

- **Dashboard** → http://localhost:3000
- **API** → http://localhost:3001
- **Temporal UI** → http://localhost:8233

Spin up your first autonomous company:

```bash
curl -XPOST localhost:3001/companies -H 'content-type: application/json' \
  -d '{"prompt":"a tiny SaaS that summarizes PDFs"}'
```

**About the key:** with an `ANTHROPIC_API_KEY` in `.env`, agents think with a
real model (billed to *your* key). Leave it blank and the whole stack still runs
end-to-end in a deterministic offline mode — perfect for a first look. Every other
integration in `.env.example` (GitHub auth, email, payments, ads, cloud sandboxes)
is off by default and degrades to a local mock, so no other accounts are needed.

## Developing

```bash
bun test              # full suite, incl. the M0 exit test: 10k events, chain verifies
bun run ledger:verify # recompute the ledger hash-chain against Postgres
```

## Self-host on your own server

To run a real, reachable instance (single VPS + Docker Compose + Caddy, dashboard
on Vercel, real GitHub auth + LLM), see **[DEPLOY.md](./DEPLOY.md)** for the full
walkthrough (DNS, TLS, backups, spend kill-switch). The short version:

```sh
cp .env.prod.example .env.prod    # set your domain, secrets, ANTHROPIC_API_KEY, GitHub OAuth
docker compose -f infra/compose/docker-compose.prod.yml --env-file .env.prod up -d --build
```

The sandbox starts in `local` mode (agent code runs inside the worker container —
fine for your own companies). Flip `SANDBOX_KIND=e2b` for real microVM isolation
before exposing it to untrusted use.

## Ledger design (§9 of the spec)

Each event: `hash = SHA-256(prev_hash ‖ canonical_json(payload) ‖ seq ‖ created_at)`.
Payloads pass a versioned redactor first (secrets stripped, third-party emails
hashed). `bun run ledger:verify` recomputes the chain and reports the first
broken seq, if any.

## Threat model & honest limits

See §15 of the spec: prompt injection containment at the gateway, outbound
email throttles, no claim of legal entity creation, payments stay a pluggable
adapter (Stripe Connect default).

## License

**Not yet licensed — all rights reserved.** The source is published so you can
read it, run it locally, and self-host it for **evaluation and personal use**.
It is **not** open source under the OSI definition (yet): a permissive, copyleft,
or source-available license may follow once the model is decided. For commercial
or production use, please ask first.
