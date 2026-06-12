#!/usr/bin/env bash
# Build the sandbox rootfs (§8): bundle agentd, build the container, export its
# filesystem, and pack it into an ext4 image Firecracker boots as root.
# Requires Linux (mkfs.ext4) + Docker; see README for the no-KVM alternative.
set -euo pipefail
cd "$(dirname "$0")"

REPO_ROOT="$(git rev-parse --show-toplevel)"
SIZE_MB="${ROOTFS_SIZE_MB:-2048}"
OUT="${ROOTFS_OUT:-rootfs.ext4}"

# 1. Bundle agentd to a single self-contained main.js the guest runs.
echo "→ bundling agentd"
rm -rf agentd && mkdir -p agentd
bun build "${REPO_ROOT}/services/agentd/src/main.ts" \
  --target=bun --outfile=agentd/main.js

# 2. Build the image and export its filesystem.
echo "→ building container image"
docker build -t opencorp-sandbox-rootfs .
CID="$(docker create opencorp-sandbox-rootfs)"
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT
docker export "$CID" -o rootfs.tar

# 3. Pack into an ext4 image.
echo "→ packing ${OUT} (${SIZE_MB} MiB)"
rm -f "$OUT"
dd if=/dev/zero of="$OUT" bs=1M count="$SIZE_MB" status=none
mkfs.ext4 -q -d <(tar -xf rootfs.tar) "$OUT" 2>/dev/null || {
  # Portable fallback: extract then copy into a mounted image.
  MNT="$(mktemp -d)"; mkdir -p "$MNT/x"
  tar -xf rootfs.tar -C "$MNT/x"
  mkfs.ext4 -q "$OUT"
  sudo mount -o loop "$OUT" "$MNT/m" 2>/dev/null && sudo cp -a "$MNT/x/." "$MNT/m/" && sudo umount "$MNT/m"
  rm -rf "$MNT"
}
rm -f rootfs.tar
echo "✓ ${OUT} ready — point FirecrackerConfig.rootfsPath at it"
