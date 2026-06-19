# Bun services: api, gateway, deployd. One image; the per-service command is set
# in docker-compose.prod.yml. Chromium is installed for the gateway's browser
# automation (harmless/unused for api + deployd).
FROM oven/bun:1-debian

WORKDIR /app

# Install workspace deps (copy the whole monorepo — bun workspaces need the
# package.jsons; a fine-grained copy is a later optimization).
COPY . .
RUN bun install --frozen-lockfile

# Real headless browser for browser-mcp (§7.1). --with-deps pulls the apt
# libraries Chromium needs. Drop this layer if you set BROWSER_KIND=fetch.
RUN bunx playwright install --with-deps chromium

ENV NODE_ENV=production
# Default command is overridden per service in compose.
CMD ["bun", "apps/api/src/index.ts"]
