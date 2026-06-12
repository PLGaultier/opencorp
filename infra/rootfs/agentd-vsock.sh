#!/usr/bin/env bash
# In-guest vsock bridge (§8). Listens on the AF_VSOCK port the host connects to
# and, for each connection, pipes it straight into `agentd` stdin/stdout. agentd
# reads the WorkerSpec and streams WorkerEvents — it neither knows nor cares that
# the other end is a microVM boundary. `fork` gives each task a fresh agentd
# process (one task per VM, but fork keeps the bridge robust to restores).
set -euo pipefail
PORT="${VSOCK_PORT:-5252}"
exec socat "VSOCK-LISTEN:${PORT},fork,reuseaddr" \
  "EXEC:'bun /opt/agentd/main.js',stderr"
