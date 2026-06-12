import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { WorkerSpec, WorkerTaskResult } from "@opencorp/agentd";
import { CapacityGate, type OnStep, type Sandbox, type SandboxPool, type SandboxSpec } from "./pool";
import { WorkerEventSink } from "./events";

/**
 * Firecracker microVM pool (§8). True VM isolation for arbitrary AI-written
 * code: one snapshot-restored microVM per task (~125 ms boot), jailer + seccomp,
 * cgroups budgets, virtio-net behind the logging egress proxy. The data path is
 * identical to the subprocess pool — a `WorkerSpec` in, NDJSON `WorkerEvent`s
 * out — only the transport differs (guest vsock instead of a stdout pipe).
 *
 * The host transport is injected so the pool's lifecycle logic is testable off
 * bare metal; the real `LinuxFirecrackerHost` requires Linux + /dev/kvm and is
 * selected only when {@link firecrackerSupported} is true.
 */
export interface VmHandle {
  readonly id: string;
  /** Send the spec to the in-guest agentd over vsock; invoke `onLine` per NDJSON line. */
  exec(spec: WorkerSpec, onLine: (line: string) => void): Promise<void>;
  /** Tear the VM down (kill firecracker, remove sockets). Never reused (§5.3). */
  destroy(): Promise<void>;
}

export interface FirecrackerHost {
  /** Boot or snapshot-restore one microVM, ready to receive a task. */
  spawnVm(id: string): Promise<VmHandle>;
}

export interface FirecrackerConfig {
  /** Memory snapshot to restore from (the pre-warmed rootfs + agentd, §8). */
  snapshotPath?: string;
  memFilePath?: string;
  /** Kernel + rootfs for cold boot when no snapshot is configured. */
  kernelImagePath?: string;
  rootfsPath?: string;
  /** Directory for per-VM api/vsock sockets and jailer chroots. */
  runDir?: string;
  /** vsock port the in-guest agentd listens on. */
  vsockPort?: number;
}

/** Host can actually run Firecracker microVMs (KVM, Linux). */
export function firecrackerSupported(): boolean {
  return process.platform === "linux" && existsSync("/dev/kvm");
}

class FirecrackerSandbox implements Sandbox {
  readonly id: string;
  private released = false;
  private used = false;

  constructor(
    private vm: VmHandle,
    private budgets: SandboxSpec["budgets"],
    private onRelease: () => void,
  ) {
    this.id = `fc-${vm.id}`;
  }

  async execAgent(spec: WorkerSpec, onStep?: OnStep): Promise<WorkerTaskResult> {
    if (this.released) throw new Error("sandbox_already_released");
    if (this.used) throw new Error("sandbox_already_used"); // one task per microVM (§5.3)
    this.used = true;

    const wall = this.budgets?.maxWallClockMs ?? spec.budgets?.maxWallClockMs;
    let timedOut = false;
    const timer = wall
      ? setTimeout(() => {
          timedOut = true;
          void this.vm.destroy(); // hard kill the VM; the vsock stream then ends
        }, wall)
      : null;

    const sink = new WorkerEventSink(onStep);
    try {
      await this.vm.exec(spec, (line) => sink.feed(line));
      if (timedOut) throw new Error("wall_clock_budget_exceeded");
      return sink.finish(`microVM ${this.vm.id}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async run<T>(): Promise<T> {
    throw new Error("firecracker_sandbox_requires_execAgent");
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.vm.destroy(); // microVMs are never reused across tasks (§5.3)
    this.onRelease();
  }
}

export interface FirecrackerPoolOptions {
  capacity?: number;
  /** Pre-booted VMs kept warm for sub-second claim latency (§11.3). */
  warmTarget?: number;
  config?: FirecrackerConfig;
  /** Injected transport; defaults to the real Linux/KVM host. */
  host?: FirecrackerHost;
}

export class FirecrackerSandboxPool implements SandboxPool {
  readonly kind = "firecracker";
  private gate: CapacityGate;
  private host: FirecrackerHost;
  private warmTarget: number;
  private warm: VmHandle[] = [];

  constructor(opts: FirecrackerPoolOptions = {}) {
    this.gate = new CapacityGate(opts.capacity ?? 12); // ~12 concurrent tasks/AX node (§12)
    this.warmTarget = opts.warmTarget ?? 2; // §11.3: keep pool ≥ max(2, …)
    if (opts.host) {
      this.host = opts.host;
    } else if (firecrackerSupported()) {
      this.host = new LinuxFirecrackerHost(opts.config ?? {});
    } else {
      throw new Error(
        "firecracker_unsupported_host: requires Linux + /dev/kvm (use SANDBOX_KIND=subprocess off bare metal)",
      );
    }
  }

  async claim(spec: SandboxSpec): Promise<Sandbox> {
    await this.gate.acquire();
    let vm: VmHandle;
    try {
      vm = this.warm.shift() ?? (await this.host.spawnVm(randomUUID().slice(0, 8)));
    } catch (err) {
      this.gate.release();
      throw err;
    }
    void this.replenish(); // top the warm pool back up off the hot path
    return new FirecrackerSandbox(vm, spec.budgets, () => this.gate.release());
  }

  /** Pre-boot VMs up to the warm target so claims stay sub-second (§11.3). */
  async prewarm(): Promise<void> {
    await this.replenish();
  }

  private async replenish(): Promise<void> {
    while (this.warm.length < this.warmTarget) {
      try {
        this.warm.push(await this.host.spawnVm(randomUUID().slice(0, 8)));
      } catch {
        break; // host saturated; claim() will cold-boot on demand
      }
    }
  }

  stats() {
    return this.gate.stats(this.kind);
  }
}

/**
 * Real Firecracker transport (Linux + KVM). Each microVM is a firecracker
 * process driven over its API unix socket; the task spec and event stream travel
 * over a guest vsock. This is the bare-metal path from §8/§12 — it cannot boot a
 * VM without /dev/kvm, which is why the pool guards construction behind
 * {@link firecrackerSupported}. The control flow (restore snapshot → configure
 * vsock → start → stream → kill) is implemented faithfully so deployment on an
 * AX node is config, not code.
 */
export class LinuxFirecrackerHost implements FirecrackerHost {
  constructor(private config: FirecrackerConfig) {}

  async spawnVm(id: string): Promise<VmHandle> {
    const runDir = this.config.runDir ?? "/run/opencorp/firecracker";
    const apiSock = `${runDir}/${id}.api.sock`;
    const vsockUds = `${runDir}/${id}.vsock.sock`;
    const port = this.config.vsockPort ?? 5252;
    const cfg = this.config;

    // Launch the firecracker process bound to a fresh API socket. The jailer +
    // seccomp + cgroups wrapping happens in the systemd unit / infra layer.
    const proc = Bun.spawn({
      cmd: ["firecracker", "--api-sock", apiSock, "--id", id],
      stdout: "inherit",
      stderr: "inherit",
    });

    const api = (path: string, body: unknown) =>
      fetch(`http://localhost${path}`, {
        method: "PUT",
        unix: apiSock, // Bun-specific: HTTP over a unix domain socket
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      } as unknown as RequestInit);

    // Configure the host↔guest vsock before bringing the VM up.
    await api("/vsock", { guest_cid: 3, uds_path: vsockUds });

    if (cfg.snapshotPath && cfg.memFilePath) {
      // Fast path: restore from a memory snapshot (~125 ms, §8).
      await api("/snapshot/load", {
        snapshot_path: cfg.snapshotPath,
        mem_file_path: cfg.memFilePath,
        resume_vm: true,
      });
    } else {
      // Cold boot from kernel + rootfs.
      await api("/boot-source", {
        kernel_image_path: cfg.kernelImagePath,
        boot_args: "console=ttyS0 reboot=k panic=1 pci=off",
      });
      await api("/drives/rootfs", {
        drive_id: "rootfs",
        path_on_host: cfg.rootfsPath,
        is_root_device: true,
        is_read_only: false,
      });
      await api("/actions", { action_type: "InstanceStart" });
    }

    return new VsockVmHandle(id, proc, apiSock, vsockUds, port);
  }
}

/** A live microVM: streams a task over its vsock UDS, then is destroyed. */
class VsockVmHandle implements VmHandle {
  constructor(
    readonly id: string,
    private proc: ReturnType<typeof Bun.spawn>,
    private apiSock: string,
    private vsockUds: string,
    private port: number,
  ) {}

  async exec(spec: WorkerSpec, onLine: (line: string) => void): Promise<void> {
    // Firecracker host-initiated vsock: connect to the UDS, request the guest
    // port, then the socket is a transparent pipe to the in-guest agentd.
    const port = this.port;
    const vsockUds = this.vsockUds;
    const payload = JSON.stringify(spec);
    const decoder = new TextDecoder();
    let buffer = "";
    let handshook = false;

    await new Promise<void>((resolve, reject) => {
      void Bun.connect({
        unix: vsockUds,
        socket: {
          open(sock) {
            sock.write(`CONNECT ${port}\n`);
          },
          data(sock, chunk: Uint8Array) {
            buffer += decoder.decode(chunk, { stream: true });
            if (!handshook) {
              // Firecracker replies "OK <host_port>\n" once the guest accepts.
              const nl = buffer.indexOf("\n");
              if (nl < 0) return;
              handshook = true;
              buffer = buffer.slice(nl + 1);
              sock.write(payload);
              sock.flush?.();
            }
            let nl: number;
            while ((nl = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, nl);
              buffer = buffer.slice(nl + 1);
              if (line.trim()) onLine(line);
            }
          },
          close() {
            if (buffer.trim()) onLine(buffer);
            resolve();
          },
          error(_sock, err) {
            reject(err);
          },
        },
      } as Parameters<typeof Bun.connect>[0]).catch(reject);
    });
  }

  async destroy(): Promise<void> {
    this.proc.kill(9);
    await Bun.spawn({ cmd: ["rm", "-f", this.apiSock, this.vsockUds] }).exited.catch(() => {});
  }
}
