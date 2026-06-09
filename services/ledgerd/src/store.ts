import postgres from "postgres";
import {
  GENESIS_HASH,
  computeHash,
  type LedgerEvent,
  type LedgerEventInput,
} from "./chain";

export interface LedgerStore {
  /** Atomically assign seq, link to the chain head, and persist. */
  append(input: LedgerEventInput): Promise<LedgerEvent>;
  /** Stream events in seq order, inclusive bounds. */
  range(fromSeq?: number, toSeq?: number): AsyncIterable<LedgerEvent>;
  head(): Promise<LedgerEvent | null>;
  close(): Promise<void>;
}

// ── In-memory store (tests, dev without PG) ────────────────────────────────
export class MemoryStore implements LedgerStore {
  readonly events: LedgerEvent[] = [];

  async append(input: LedgerEventInput): Promise<LedgerEvent> {
    const prev = this.events[this.events.length - 1];
    const seq = (prev?.seq ?? 0) + 1;
    const prevHash = prev?.hash ?? GENESIS_HASH;
    const createdAt = new Date().toISOString();
    const hash = computeHash(prevHash, input.payload, seq, createdAt);
    const ev: LedgerEvent = { ...input, seq, createdAt, prevHash, hash };
    this.events.push(ev);
    return ev;
  }

  async *range(fromSeq = 1, toSeq = Infinity): AsyncIterable<LedgerEvent> {
    for (const ev of this.events) {
      if (ev.seq >= fromSeq && ev.seq <= toSeq) yield ev;
    }
  }

  async head(): Promise<LedgerEvent | null> {
    return this.events[this.events.length - 1] ?? null;
  }

  async close(): Promise<void> {}
}

// ── Postgres store ─────────────────────────────────────────────────────────
export class PgStore implements LedgerStore {
  private sql: postgres.Sql;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 5 });
  }

  /**
   * Serializes appends with an advisory xact lock so the chain head cannot
   * race under concurrent writers. created_at is generated here (not by PG)
   * because it is part of the hashed material.
   */
  async append(input: LedgerEventInput): Promise<LedgerEvent> {
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('ledger_head'))`;
      const [prev] = await tx<{ seq: string; hash: Uint8Array }[]>`
        SELECT seq, hash FROM ledger_events ORDER BY seq DESC LIMIT 1`;
      const seq = prev ? Number(prev.seq) + 1 : 1;
      const prevHash = prev ? new Uint8Array(prev.hash) : GENESIS_HASH;
      const createdAt = new Date().toISOString();
      const hash = computeHash(prevHash, input.payload, seq, createdAt);
      await tx`
        INSERT INTO ledger_events (seq, company_id, actor, event_type, payload, prev_hash, hash, created_at)
        VALUES (${seq}, ${input.companyId}, ${input.actor}, ${input.eventType},
                ${tx.json(input.payload as never)}, ${Buffer.from(prevHash)}, ${Buffer.from(hash)}, ${createdAt})`;
      await tx`SELECT pg_notify('ledger_events', ${JSON.stringify({ seq, eventType: input.eventType, companyId: input.companyId })})`;
      return { ...input, seq, createdAt, prevHash, hash };
    });
  }

  async *range(fromSeq = 1, toSeq?: number): AsyncIterable<LedgerEvent> {
    const cursor = this.sql<RawRow[]>`
      SELECT seq, company_id, actor, event_type, payload, prev_hash, hash,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
      FROM ledger_events
      WHERE seq >= ${fromSeq} ${toSeq !== undefined ? this.sql`AND seq <= ${toSeq}` : this.sql``}
      ORDER BY seq`.cursor(500);
    for await (const rows of cursor) {
      for (const r of rows) yield rowToEvent(r);
    }
  }

  async head(): Promise<LedgerEvent | null> {
    const [r] = await this.sql<RawRow[]>`
      SELECT seq, company_id, actor, event_type, payload, prev_hash, hash,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
      FROM ledger_events ORDER BY seq DESC LIMIT 1`;
    return r ? rowToEvent(r) : null;
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}

interface RawRow {
  seq: string;
  company_id: string | null;
  actor: string;
  event_type: string;
  payload: unknown;
  prev_hash: Uint8Array;
  hash: Uint8Array;
  created_at: string;
}

function rowToEvent(r: RawRow): LedgerEvent {
  return {
    seq: Number(r.seq),
    companyId: r.company_id,
    actor: r.actor,
    eventType: r.event_type,
    payload: r.payload,
    prevHash: new Uint8Array(r.prev_hash),
    hash: new Uint8Array(r.hash),
    createdAt: r.created_at,
  };
}
