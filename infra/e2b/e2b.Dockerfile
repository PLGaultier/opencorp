# OpenCorp worker template for E2B sandboxes (§8).
#
# Deliberately minimal: only the runtime + system deps live here. agentd itself
# is NOT baked in — the E2bSandboxPool bundles the in-repo agentd and uploads it
# at claim time, so this template only needs rebuilding when system deps change.
#
# Bun goes to /usr/local because E2B runs commands as the unprivileged `user`,
# which can't see /root/.bun.
FROM e2bdev/base

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ripgrep unzip ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
