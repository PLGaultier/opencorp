#!/usr/bin/env bun
/**
 * opencorp insights CLI — a per-company business read-out for the operator.
 *   bun run packages/insights/src/cli.ts <company-slug> [--range 7] [--json]
 * Uses DATABASE_URL (default: local dev compose PG). Visitor analytics needs the
 * gateway's per-company secret, so the CLI reports the DB-derived funnel (ad
 * clicks → sales); the `insights.get_report` agent tool adds live visitors.
 */
import postgres from "postgres";
import { buildReport } from "./report";
import { renderReport } from "./format";

const url = process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith("--"));
const json = args.includes("--json");
const rangeIdx = args.indexOf("--range");
const rangeDays = rangeIdx >= 0 && args[rangeIdx + 1] ? Math.max(1, Number(args[rangeIdx + 1])) : 7;

if (!slug) {
  console.error("usage: insights <company-slug> [--range 7] [--json]");
  process.exit(2);
}

const sql = postgres(url, { max: 2 });
try {
  const [c] = await sql<
    { id: string; name: string; slug: string; conglomerate_id: string; real_balance_cents: string }[]
  >`SELECT id, name, slug, conglomerate_id, real_balance_cents FROM companies WHERE slug = ${slug}`;
  if (!c) {
    console.error(`no company with slug "${slug}"`);
    process.exit(1);
  }
  const report = await buildReport(sql, {
    company: {
      id: c.id,
      name: c.name,
      slug: c.slug,
      conglomerateId: c.conglomerate_id,
      realBalanceCents: Number(c.real_balance_cents),
    },
    rangeDays,
  });
  console.log(json ? JSON.stringify(report, null, 2) : renderReport(report));
} finally {
  await sql.end();
}
