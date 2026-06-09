import type { LedgerEvent, LedgerEventInput, VerifyResult } from "./chain";
import { verifyChain, GENESIS_HASH } from "./chain";
import type { LedgerStore } from "./store";
import { redact } from "./redact";

/** High-level facade: redact → append; verify ranges. */
export class Ledger {
  constructor(private store: LedgerStore) {}

  append(input: LedgerEventInput): Promise<LedgerEvent> {
    return this.store.append({ ...input, payload: redact(input.payload) });
  }

  async verify(fromSeq = 1, toSeq?: number): Promise<VerifyResult> {
    // Anchoring mid-chain requires the predecessor's hash.
    let anchor: Uint8Array = GENESIS_HASH;
    if (fromSeq > 1) {
      for await (const ev of this.store.range(fromSeq - 1, fromSeq - 1)) {
        anchor = ev.hash;
      }
    }
    const events: LedgerEvent[] = [];
    const result = await (async () => {
      // verifyChain is sync over an iterable; buffer in chunks via async gen bridge
      let prevAnchor: Uint8Array = anchor;
      let checked = 0;
      const CHUNK = 1000;
      for await (const ev of this.store.range(fromSeq, toSeq)) {
        events.push(ev);
        if (events.length >= CHUNK) {
          const r = verifyChain(events, prevAnchor);
          if (!r.ok) return { ...r, checked: checked + r.checked };
          checked += r.checked;
          prevAnchor = events[events.length - 1]!.hash;
          events.length = 0;
        }
      }
      const r = verifyChain(events, prevAnchor);
      return { ...r, checked: checked + r.checked };
    })();
    return result;
  }

  head(): Promise<LedgerEvent | null> {
    return this.store.head();
  }
}
