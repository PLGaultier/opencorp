#!/usr/bin/env bun
/**
 * opencorp ledger CLI
 *   bun run src/cli.ts verify [--from N] [--to N]
 *   bun run src/cli.ts head
 * Uses DATABASE_URL (default: local dev compose PG).
 */
import { Ledger } from "./ledger";
import { PgStore } from "./store";

const url = process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const [cmd, ...rest] = process.argv.slice(2);

function flag(name: string): number | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? Number(rest[i + 1]) : undefined;
}

const store = new PgStore(url);
const ledger = new Ledger(store);

try {
  switch (cmd) {
    case "verify": {
      const from = flag("from") ?? 1;
      const to = flag("to");
      const r = await ledger.verify(from, to);
      if (r.ok) {
        console.log(`OK — chain verified, ${r.checked} events checked`);
      } else {
        console.error(`BROKEN at seq ${r.brokenAt} (${r.reason}) after ${r.checked} good events`);
        process.exit(1);
      }
      break;
    }
    case "head": {
      const h = await ledger.head();
      if (!h) {
        console.log("empty ledger");
      } else {
        console.log(JSON.stringify({ seq: h.seq, hash: Buffer.from(h.hash).toString("hex"), createdAt: h.createdAt }, null, 2));
      }
      break;
    }
    default:
      console.error("usage: cli.ts <verify [--from N] [--to N] | head>");
      process.exit(2);
  }
} finally {
  await store.close();
}
