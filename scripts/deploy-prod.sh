#!/usr/bin/env bash
#
# Incremental prod redeploy. Runs ON the VPS, from the repo root (/opt/opencorp).
# Pulls master, applies DB migrations, then rebuilds & recreates ONLY the app
# services — the stateful infra (postgres, temporal, caddy, stalwart) is left
# running untouched. litellm is infra too, but its mounted config is reloaded
# when it changes (see step 5), since a new model_list only applies on restart.
#
# Usage, from your laptop:
#   ssh opencorp-vps 'cd /opt/opencorp && ./scripts/deploy-prod.sh'
#
# Migration ordering: migrations run BEFORE the new app code starts. That is safe
# for additive changes (new table/column/enum value — the vast majority). For a
# DESTRUCTIVE change (drop/rename a column the running code still reads), use the
# expand→contract pattern across two deploys instead of shipping it in one.
set -euo pipefail

cd "$(dirname "$0")/.."  # repo root, regardless of where it's invoked from

COMPOSE="docker compose --env-file .env.prod -f infra/compose/docker-compose.prod.yml"
APP_SERVICES="worker api gateway deployd"  # share the app image; NOT the infra services

LITELLM_CFG="infra/compose/litellm.config.yaml"
cfg_hash() { sha256sum "$LITELLM_CFG" 2>/dev/null | cut -d' ' -f1 || echo none; }

echo "▶ 1/6  pull master"
CFG_BEFORE=$(cfg_hash)
git fetch --quiet origin master
git merge --ff-only origin/master
CFG_AFTER=$(cfg_hash)

echo "▶ 2/6  build app images"
# `migrate` MUST be rebuilt too: it bakes the migrations dir into its image, so a
# stale migrate image silently skips new migrations (drizzle sees only the files
# it was built with → "nothing to apply") while the freshly-built app code expects
# the new columns. Build it alongside the app services before running it in 3/5.
$COMPOSE build migrate $APP_SERVICES

echo "▶ 3/6  apply DB migrations"
$COMPOSE run --rm migrate

echo "▶ 4/6  recreate app services (infra untouched)"
$COMPOSE up -d --no-deps $APP_SERVICES

echo "▶ 5/6  reload litellm if its mounted config changed"
# litellm reads its config once at startup and is otherwise left running as infra,
# so a new model_list (e.g. a new model bundle) only takes effect when the
# container is recreated. Do that only when the file actually changed, to avoid an
# LLM blip on every deploy. (This is why the GLM bundle silently 404'd in prod
# until litellm was manually recreated.)
if [ "$CFG_BEFORE" != "$CFG_AFTER" ]; then
  echo "   litellm.config.yaml changed — recreating litellm to reload it"
  $COMPOSE up -d --no-deps --force-recreate litellm
else
  echo "   litellm.config.yaml unchanged — leaving it running"
fi

echo "▶ 6/6  verify"
$COMPOSE ps --format "table {{.Service}}\t{{.Status}}"
curl -fsS https://api.opencorp.app/healthz && echo
echo "✓ deploy complete — tail logs with:"
echo "  $COMPOSE logs -f --tail=50 worker"
