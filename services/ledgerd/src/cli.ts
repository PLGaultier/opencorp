#!/usr/bin/env bun
/**
 * opencorp ledger CLI
 *   bun run src/cli.ts verify [--from N] [--to N]
 *   bun run src/cli.ts audit  [--from N] [--to N]
 *   bun run src/cli.ts head
 * Uses DATABASE_URL (default: local dev compose PG).
 */
import { Ledger } from "./ledger";
import { PgStore } from "./store";
import { auditChain } from "./audit";

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
    case "audit": {
      const from = flag("from") ?? 1;
      const to = flag("to");
      const { scanned, violations } = await auditChain(store, from, to);
      if (violations.length === 0) {
        console.log(`OK — redaction holds, ${scanned} events scanned, 0 violations`);
      } else {
        console.error(`LEAK — ${violations.length} redaction violation(s) in ${scanned} events:`);
        for (const v of violations.slice(0, 50))
          console.error(`  seq ${v.seq} [${v.eventType}] ${v.kind}: ${v.sample}`);
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
      console.error("usage: cli.ts <verify [--from N] [--to N] | audit [--from N] [--to N] | head>");
      process.exit(2);
  }
} finally {
  await store.close();
}
