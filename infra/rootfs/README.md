# Sandbox rootfs (§8)

The image that runs **inside** every Firecracker microVM. It boots, brings up a
vsock bridge, and hands each incoming task to `agentd` — the same runtime the
subprocess pool spawns as a child process. The host side lives in
[`services/sandboxd/src/firecracker.ts`](../../services/sandboxd/src/firecracker.ts).

## Contract

The host (`LinuxFirecrackerHost`) connects to the guest over **vsock** on
`VSOCK_PORT` (default `5252`), writes a `WorkerSpec` as one JSON value, then
reads `WorkerEvent`s as NDJSON until the connection closes:

```
host ──connect vsock:5252──▶ guest
host ──{WorkerSpec JSON}────▶ agentd (stdin)
host ◀──{"type":"step",…}\n── agentd (stdout)
host ◀──{"type":"result",…}\n agentd (stdout)   # or {"type":"error",…}
```

`agentd` is platform-agnostic: it reads stdin and writes stdout
([`services/agentd/src/main.ts`](../../services/agentd/src/main.ts)). The only
guest-specific piece is bridging the AF_VSOCK port to that stdio, done by
`agentd-vsock.sh` via `socat`.

## Contents (per spec §8)

Ubuntu 24 minimal · Bun · Node 22 + pnpm · Python 3.12 + uv · git · ripgrep ·
Playwright + Chromium · the `agentd` bundle · `socat` for the vsock bridge.

## Build

```sh
./build.sh            # docker build → export → mkfs.ext4 → rootfs.ext4
```

Produces `rootfs.ext4`, booted by Firecracker as the root device. To use the
fast snapshot-restore path (~125 ms claim, §8), boot one VM, snapshot it
(`PUT /snapshot/create`), and point `FirecrackerConfig.snapshotPath` /
`memFilePath` at the result; `LinuxFirecrackerHost` then restores instead of
cold-booting.

> Building the ext4 image and booting it require Linux + `/dev/kvm`. Off bare
> metal, select `SANDBOX_KIND=subprocess` for real process isolation without a
> VM (see [`factory.ts`](../../services/sandboxd/src/factory.ts)).
