# Deploying OpenCorp (Phase A — one real instance online)

Goal: a real, reachable instance — backend on a single VPS via Docker Compose +
Caddy, the dashboard on Vercel, real GitHub auth, real LLM. Sandbox starts in
`local` mode (get it online) and you flip to E2B once it's working.

The web app runs on **Vercel** (already wired). Everything else runs on the VPS.

---

## 0. What to set up first (do these in parallel)

1. **A VPS** — 4 vCPU / 8 GB RAM / 40 GB disk (Chromium + Temporal + Postgres
   are the heavy bits). Ubuntu 22.04+. Install Docker + the compose plugin.
2. **A domain** you control (the apex, 2 labels, e.g. `example.com`).
3. **DNS records** → point at the VPS IP:
   | Type | Name | Value |
   |------|------|-------|
   | A | `api` | VPS IP |
   | A | `gw` | VPS IP |
   | A | `llm` | VPS IP |
   | A | `*` (wildcard) | VPS IP |
   | A | `@` (apex) | VPS IP |
   | CNAME | `app` | your Vercel domain (the dashboard) |
4. **GitHub OAuth App** (github.com/settings/developers) — Authorization callback URL:
   `https://api.example.com/api/auth/callback/github`. Save the client id + secret.
5. **Anthropic API key** (LLM).
6. *(Phase B, later)* Stripe keys, an E2B account.

---

## 1. Configure

```sh
git clone <your repo> && cd OpenCorp
cp .env.prod.example .env.prod
# Edit .env.prod: replace every example.com with your domain, set strong
# POSTGRES_PASSWORD / GATEWAY_SECRET / LITELLM_API_KEY / BETTER_AUTH_SECRET
# (openssl rand -hex 32 each), and paste ANTHROPIC_API_KEY + GitHub OAuth creds.
# Optional: set ZAI_API_KEY to enable the GLM provider bundle (OPE-6) — companies
# on model_bundle='glm' then run on cheaper z.ai models. It's already mapped into
# the litellm container in docker-compose.prod.yml.
# BETTER_AUTH_SECRET is REQUIRED — the api refuses to boot in production without it.
```

## 2. Launch the backend

```sh
docker compose -f infra/compose/docker-compose.prod.yml --env-file .env.prod up -d --build
```

First build is slow (it downloads Chromium). `migrate` runs once, then the
services start. Watch logs:

```sh
docker compose -f infra/compose/docker-compose.prod.yml logs -f --tail=50
```

## 3. Point the dashboard (Vercel) at the API

In the Vercel project settings → Environment Variables (Production):

| Key | Value |
|-----|-------|
| `NEXT_PUBLIC_API_URL` | `https://api.example.com` |
| `NEXT_PUBLIC_AUTH_GITHUB` | `1` |
| `NEXT_PUBLIC_AUTH_DISABLED` | `0` |

Redeploy the web app, and set the `app.example.com` domain on the Vercel project.

## 4. Smoke test

```sh
curl https://api.example.com/healthz          # {"ok":true,...}
curl https://gw.example.com/healthz           # gateway reachable (needed for E2B later)
```

Then in a browser: open `https://app.example.com` → **Sign in with GitHub** →
**Found a company** → confirm it provisions and its site loads at
`https://<slug>.example.com`.

---

## 5. Flip the sandbox to E2B (real isolation)

The `local` baseline runs agent code inside the worker container — fine while you
only run your own companies. For untrusted/real use, switch to E2B:

1. Create an E2B account + API key; build the template in `infra/e2b`.
2. In `.env.prod`: `SANDBOX_KIND=e2b`, `E2B_API_KEY=…`, and change
   `GATEWAY_URL=https://gw.example.com` and `LITELLM_URL=https://llm.example.com`
   (the cloud sandbox must reach them over the public internet — they're
   protected by signed tokens / the LiteLLM key).
3. `docker compose -f infra/compose/docker-compose.prod.yml --env-file .env.prod up -d`

---

## Notes & gotchas

- **TLS for company sites** is issued on first visit (Caddy on-demand TLS),
  authorized by deployd's `/exists` so only published slugs get a cert.
- **`{labels.2}` in `Caddyfile.prod`** assumes a 2-label apex (`acme.example.com`).
  For a deeper base domain, bump the index.
- **Temporal** here uses `auto-setup` against the same Postgres for simplicity;
  for scale, give it a dedicated DB or Temporal Cloud.
- **Backups**: snapshot the `pgdata` volume (control DB + ledger + per-company
  DBs) regularly — that's your whole world of record.
- **Before unpausing real spend** (ads/withdrawals), do Phase C (spend ceilings +
  kill switch). The starter ad campaign ships paused for this reason.
