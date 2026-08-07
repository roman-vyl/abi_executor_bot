import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { positionScopeKey } from "../domain/positionScope.js";
import type { ExchangeInstrumentCategory } from "../exchange/exchangeInstrumentResolver.js";
import type { EntryPackageExecutionRecord } from "./entryPackageExecutionRecord.js";
import {
  correlationRecordKey,
  isDurablyClosedEntryPackageStatus,
  isValidEntryPackageExecutionRecord,
} from "./entryPackageExecutionRecord.js";

export type CorrelationReplayResult = { ok: true } | { ok: false; reason: string };

// Durable, ABI-owned, single-writer append-only JSONL store of
// EntryPackageExecutionRecords. Not built on Journal: Journal's public query
// surface is signal-shaped and its lenient corruption handling (skip and
// continue) is wrong for a correctness-critical store, which here must fail
// readiness on any non-final corruption instead (design.md §4).
export class EntryPackageCorrelationRepository {
  private readonly path: string;
  private readonly byCompositeKey = new Map<string, EntryPackageExecutionRecord>();
  private readonly byOrderLinkId = new Map<string, EntryPackageExecutionRecord>();
  private readonly byOrderId = new Map<string, EntryPackageExecutionRecord>();
  // Current physical-position-scope ownership, derived from byCompositeKey.
  // Unlike the two indexes above (append-only forever), this one has
  // release semantics and is maintained differently for live writes vs.
  // replay — see applyScopeClaimOnWrite() and rebuildScopeIndexFromReplay()
  // (position-scope-exclusivity design.md Decisions 2 and 8).
  private readonly byScope = new Map<string, EntryPackageExecutionRecord>();

  // FIFO queue serializing physical appends across all keys, since every
  // write shares one file. This is independent of the per-key business-logic
  // mutex in src/concurrency/keyedMutex.ts (design.md §4).
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async replay(): Promise<CorrelationReplayResult> {
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) {
        return { ok: true };
      }
      return {
        ok: false,
        reason: error instanceof Error ? error.message : "failed to read correlation store",
      };
    }

    const lines = content.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === "") {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        const isFinalLine = index === lines.length - 1;
        if (isFinalLine) {
          // Tolerate a truncated tail left by a crash mid-append.
          continue;
        }
        return { ok: false, reason: `corrupt correlation record at line ${index + 1}` };
      }

      // A syntactically-valid-but-wrong-shaped line (e.g. from a future
      // schema migration bug) is corruption too, and must fail readiness
      // the same way malformed JSON does — never be silently indexed.
      if (!isValidEntryPackageExecutionRecord(parsed)) {
        const isFinalLine = index === lines.length - 1;
        if (isFinalLine) {
          continue;
        }
        return { ok: false, reason: `correlation record at line ${index + 1} does not match the expected schema` };
      }

      // Phase 1: replay every valid line, keyed indexes only. byScope is
      // deliberately not touched here — an intermediate line can show a
      // scope legitimately mid-transfer between two pairs before a later
      // line for the earlier pair resolves it, so per-line claim/release
      // would either false-positive on that intermediate moment or
      // silently overwrite a still-active claim (design.md Decision 8).
      this.indexRecord(parsed);
    }

    // Phase 2: ownership is evaluated once, only from each pair's latest
    // (post-Phase-1) record — never from a superseded intermediate one.
    const conflict = this.rebuildScopeIndexFromReplay();
    if (conflict !== undefined) {
      return { ok: false, reason: conflict };
    }

    return { ok: true };
  }

  get(strategyInstanceId: string, tradeCycleId: string): EntryPackageExecutionRecord | undefined {
    return this.byCompositeKey.get(correlationRecordKey(strategyInstanceId, tradeCycleId));
  }

  findByOrderLinkId(orderLinkId: string): EntryPackageExecutionRecord | undefined {
    return this.byOrderLinkId.get(orderLinkId);
  }

  findByOrderId(orderId: string): EntryPackageExecutionRecord | undefined {
    return this.byOrderId.get(orderId);
  }

  // The pair, if any, currently holding this physical scope. Callers
  // acquiring a new scope binding must serialize this read together with
  // the durable write that claims it under the scope-level KeyedMutex —
  // this method itself performs no locking (position-scope-exclusivity
  // design.md Decisions 2, 6).
  findOwnerByScope(category: ExchangeInstrumentCategory, symbol: string): EntryPackageExecutionRecord | undefined {
    return this.byScope.get(positionScopeKey(category, symbol));
  }

  async save(record: EntryPackageExecutionRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;

    const task = this.writeQueue.then(() => this.appendDurable(line));
    // A failed append must not wedge the queue for subsequent, unrelated
    // writes; the caller still observes the failure via `task` below.
    this.writeQueue = task.catch(() => undefined);
    await task;

    this.indexRecord(record);
    // Live-write-only scope claim/release (design.md Decision 2). Correct
    // here specifically because live save() calls are already strictly
    // ordered by the pair-lock and scope-lock, so this record is always
    // already the latest for its pair the instant this runs — unlike
    // replay, there is no later line still to arrive that could change the
    // answer. See rebuildScopeIndexFromReplay() for the startup path.
    this.applyScopeClaimOnWrite(record);
  }

  private async appendDurable(line: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const handle = await open(this.path, "a");
    try {
      await handle.appendFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private indexRecord(record: EntryPackageExecutionRecord): void {
    this.byCompositeKey.set(correlationRecordKey(record.strategy_instance_id, record.trade_cycle_id), record);

    if (record.order_link_id !== null) {
      this.byOrderLinkId.set(record.order_link_id, record);
    }
    if (record.order_id !== null) {
      this.byOrderId.set(record.order_id, record);
    }

    for (const entry of record.binding_history) {
      this.byOrderLinkId.set(entry.order_link_id, record);
      if (entry.order_id !== null) {
        this.byOrderId.set(entry.order_id, record);
      }
    }
  }

  // Live-write scope claim/release. Never call this from replay() — see
  // rebuildScopeIndexFromReplay() for why the same per-line step is unsound
  // there (design.md Decision 8).
  private applyScopeClaimOnWrite(record: EntryPackageExecutionRecord): void {
    if (record.exchange_category !== "linear" && record.exchange_category !== "spot") {
      return;
    }

    const scope = positionScopeKey(record.exchange_category, record.exchange_symbol);

    if (!isDurablyClosedEntryPackageStatus(record.status)) {
      this.byScope.set(scope, record);
      return;
    }

    // Durably closed: release, but only if this pair is still the
    // recorded owner — never delete a different pair's legitimate claim.
    const currentOwner = this.byScope.get(scope);
    if (currentOwner !== undefined && isSamePair(currentOwner, record)) {
      this.byScope.delete(scope);
    }
  }

  // Phase 2 of replay (design.md Decision 8): evaluated once, after every
  // line has been indexed into byCompositeKey, using only each pair's
  // final latest record — never an intermediate one a later line for the
  // same pair has since superseded. byCompositeKey.values() yields exactly
  // one record per pair, so a scope collision found here is necessarily
  // between two *different* pairs' latest durable state, not a sequencing
  // artifact.
  private rebuildScopeIndexFromReplay(): string | undefined {
    this.byScope.clear();

    for (const record of this.byCompositeKey.values()) {
      if (record.exchange_category !== "linear" && record.exchange_category !== "spot") {
        continue;
      }
      if (isDurablyClosedEntryPackageStatus(record.status)) {
        continue;
      }

      const scope = positionScopeKey(record.exchange_category, record.exchange_symbol);
      const existingOwner = this.byScope.get(scope);
      if (existingOwner !== undefined) {
        return (
          `conflicting scope ownership for ${scope}: both ` +
          `${correlationRecordKey(existingOwner.strategy_instance_id, existingOwner.trade_cycle_id)} and ` +
          `${correlationRecordKey(record.strategy_instance_id, record.trade_cycle_id)} are durably open`
        );
      }
      this.byScope.set(scope, record);
    }

    return undefined;
  }
}

function isSamePair(a: EntryPackageExecutionRecord, b: EntryPackageExecutionRecord): boolean {
  return a.strategy_instance_id === b.strategy_instance_id && a.trade_cycle_id === b.trade_cycle_id;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
