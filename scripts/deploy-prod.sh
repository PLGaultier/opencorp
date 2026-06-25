#!/usr/bin/env bash
#
# Incremental prod redeploy. Runs ON the VPS, from the repo root (/opt/opencorp).
# Pulls master, applies DB migrations, then rebuilds & recreates ONLY the app
# services — the stateful infra (postgres, temporal, caddy, litellm, stalwart)
# is left running untouched.
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

echo "▶ 1/5  pull master"
git fetch --quiet origin master
git merge --ff-only origin/master

echo "▶ 2/5  build app images"
$COMPOSE build $APP_SERVICES

echo "▶ 3/5  apply DB migrations"
$COMPOSE run --rm migrate

echo "▶ 4/5  recreate app services (infra untouched)"
$COMPOSE up -d --no-deps $APP_SERVICES

echo "▶ 5/5  verify"
$COMPOSE ps --format "table {{.Service}}\t{{.Status}}"
curl -fsS https://api.opencorp.app/healthz && echo
echo "✓ deploy complete — tail logs with:"
echo "  $COMPOSE logs -f --tail=50 worker"
