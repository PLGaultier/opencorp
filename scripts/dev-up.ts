#!/usr/bin/env bun
/**
 * One-command local MVP: brings up the minimal infra (Postgres + Temporal, plus
 * LiteLLM when an LLM key is set), runs migrations, then launches every app
 * process — gateway, deployd, API, Temporal worker, web — with prefixed logs and
 * clean Ctrl-C shutdown. No external accounts required.
 *
 *   bun run dev        # or: bun scripts/dev-up.ts
 *
 * Bun auto-loads .env; children inherit it (the node/tsx worker included).
 */
import net from "node:net";
import { mkdirSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const COMPOSE = ["docker", "compose", "-f", "infra/compose/docker-compose.mvp.yml"];
const HAS_LLM = !!process.env.ANTHROPIC_API_KEY || !!process.env.OPENAI_API_KEY;

const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp",
  TEMPORAL_ADDRESS: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  GATEWAY_URL: process.env.GATEWAY_URL ?? "http://localhost:3004",
  DEPLOYD_URL: process.env.DEPLOYD_URL ?? "http://localhost:3002",
  GATEWAY_SECRET: process.env.GATEWAY_SECRET ?? "dev-gateway-secret",
  SANDBOX_KIND: process.env.SANDBOX_KIND ?? "local",
  // deployd serves company sites from here (host dir, not the container's /srv).
  SITES_DIR: process.env.SITES_DIR ?? `${ROOT}.opencorp/sites`,
  // Local MVP: no signup friction. The dashboard + API act as a single dev
  // owner. NEVER expose this build publicly with auth disabled.
  OPENCORP_AUTH_DISABLED: process.env.OPENCORP_AUTH_DISABLED ?? "1",
  ...(HAS_LLM ? { LITELLM_URL: process.env.LITELLM_URL ?? "http://localhost:4000" } : {}),
};

/**
 * Ensure the dev owner has a conglomerate with credits so the one-prompt flow
 * works headless (idempotent; runs via psql in the container — no node deps from
 * this non-workspace script).
 */
const SEED_SQL =
  "INSERT INTO conglomerates (owner_user_id, name, daily_credit_cap) " +
  "SELECT 'dev-user','Local Dev','1000' WHERE NOT EXISTS (SELECT 1 FROM conglomerates WHERE owner_user_id='dev-user'); " +
  "INSERT INTO credit_entries (conglomerate_id, delta, reason) " +
  "SELECT c.id,'1000','grant' FROM conglomerates c WHERE c.owner_user_id='dev-user' " +
  "AND NOT EXISTS (SELECT 1 FROM credit_entries e WHERE e.conglomerate_id=c.id);";

function seedDevConglomerate(): Promise<void> {
  return run([...COMPOSE, "exec", "-T", "postgres", "psql", "-U", "opencorp", "-d", "opencorp",
    "-v", "ON_ERROR_STOP=1", "-c", SEED_SQL]);
}

function run(cmd: string[], opts: { cwd?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd[0]!, cmd.slice(1), { cwd: opts.cwd ?? ROOT, env, stdio: "inherit" });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd.join(" ")} → exit ${code}`))));
  });
}

function tcpUp(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((res) => {
    const s = net.connect({ port, host });
    const done = (v: boolean) => {
      s.destroy();
      res(v);
    };
    s.once("connect", () => done(true));
    s.once("error", () => res(false));
    s.setTimeout(1000, () => done(false));
  });
}

async function waitFor(label: string, probe: () => Promise<boolean>, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  process.stdout.write(`⏳ waiting for ${label}…`);
  for (;;) {
    if (await probe()) {
      console.log(" up");
      return;
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const COLORS: Record<string, string> = {
  gateway: "\x1b[36m",
  deployd: "\x1b[35m",
  api: "\x1b[32m",
  worker: "\x1b[33m",
  web: "\x1b[34m",
};
const children: ChildProcess[] = [];

function service(name: string, cmd: string[], cwd: string) {
  const color = COLORS[name] ?? "";
  const child = spawn(cmd[0]!, cmd.slice(1), { cwd: `${ROOT}${cwd}`, env });
  children.push(child);
  const prefix = (line: string) => process.stdout.write(`${color}[${name}]\x1b[0m ${line}\n`);
  const pump = (buf: Buffer) =>
    buf
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .forEach(prefix);
  child.stdout?.on("data", pump);
  child.stderr?.on("data", pump);
  child.on("close", (code) => prefix(`exited (${code})`));
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n⏹  stopping app processes + infra…");
  for (const c of children) c.kill("SIGTERM");
  await run([...COMPOSE, "stop"]).catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main() {
  console.log(`\n🏢  OpenCorp local MVP${HAS_LLM ? " (real LLM)" : " (offline mode — no LLM key set)"}\n`);

  console.log("▶ infra: Postgres + Temporal" + (HAS_LLM ? " + LiteLLM" : ""));
  await run([...COMPOSE, ...(HAS_LLM ? ["--profile", "llm"] : []), "up", "-d"]);
  await waitFor("Postgres", () => tcpUp(5432));
  await run(["docker", "compose", "-f", "infra/compose/docker-compose.mvp.yml", "exec", "-T", "postgres",
    "bash", "-c", "until pg_isready -U opencorp; do sleep 1; done"]);
  await waitFor("Temporal", () => tcpUp(7233));

  console.log("▶ migrations");
  await run(["bun", "run", "db:migrate"]);
  await seedDevConglomerate();

  mkdirSync(env.SITES_DIR, { recursive: true });

  console.log("\n▶ launching app processes (Ctrl-C to stop everything)\n");
  service("gateway", ["bun", "src/index.ts"], "/apps/gateway");
  service("deployd", ["bun", "src/server.ts"], "/services/deployd");
  service("api", ["bun", "src/index.ts"], "/apps/api");
  service("worker", ["bun", "run", "worker"], "/workflows"); // tsx under the hood (node)
  service("web", ["bun", "run", "dev"], "/apps/web");

  await waitFor("gateway", () => tcpUp(3004));
  await waitFor("api", () => tcpUp(3001));
  console.log(
    `\n✅ OpenCorp is up:\n` +
      `   dashboard   http://localhost:3000\n` +
      `   API         http://localhost:3001\n` +
      `   Temporal UI http://localhost:8233\n` +
      (HAS_LLM ? "" : `   ⚠ offline mode: add ANTHROPIC_API_KEY to .env for real AI\n`) +
      `\n   Create a company from the dashboard, or:\n` +
      `   curl -XPOST localhost:3001/companies -H 'content-type: application/json' -d '{"prompt":"a tiny SaaS that…"}'\n`,
  );
}

main().catch((err) => {
  console.error(`\n✖ ${err instanceof Error ? err.message : err}`);
  void shutdown();
});
