import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { compareDecimal } from "../domain/exactDecimal.js";
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
// readiness on any non-final corruption instead.
export class EntryPackageCorrelationRepository {
  private readonly path: string;
  private readonly byCompositeKey = new Map<string, EntryPackageExecutionRecord>();
  private readonly byOrderLinkId = new Map<string, EntryPackageExecutionRecord>();
  private readonly byOrderId = new Map<string, EntryPackageExecutionRecord>();
  // Current physical-position-scope ownership, derived from byCompositeKey.
  // Unlike the two indexes above (append-only forever), this one has
  // release semantics and is maintained differently for live writes vs.
  // replay — see applyScopeClaimOnWrite() and rebuildScopeIndexFromReplay()
  // for the two ordering rules.
  private readonly byScope = new Map<string, EntryPackageExecutionRecord>();

  // FIFO queue serializing physical appends across all keys, since every
  // write shares one file. This is independent of the per-key business-logic
  // mutex in src/concurrency/keyedMutex.ts.
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

      // Fill-fact monotonicity, checked in file order against the previous
      // line for the same pair — unlike scope ownership (Phase 2 below),
      // a single pair's own fill-fact sequence has no legitimate
      // "intermediate disagreement" case: every line for the same pair is
      // either a compatible continuation of the previous line or it is
      // real corruption, so per-line comparison is correct here.
      const key = correlationRecordKey(parsed.strategy_instance_id, parsed.trade_cycle_id);
      const regression = fillFactRegression(this.byCompositeKey.get(key), parsed);
      if (regression !== undefined) {
        return { ok: false, reason: `${regression} at line ${index + 1}` };
      }

      // Phase 1: replay every valid line, keyed indexes only. byScope is
      // deliberately not touched here — an intermediate line can show a
      // scope legitimately mid-transfer between two pairs before a later
      // line for the earlier pair resolves it, so per-line claim/release
      // would either false-positive on that intermediate moment or
      // silently overwrite a still-active claim.
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
  // this method itself performs no locking.
  findOwnerByScope(category: ExchangeInstrumentCategory, symbol: string): EntryPackageExecutionRecord | undefined {
    return this.byScope.get(positionScopeKey(category, symbol));
  }

  // Every active (non-durably-closed) record currently sharing a physical
  // scope, regardless of which pair holds it. A plain scan over
  // byCompositeKey (already the authoritative "latest record per pair"
  // collection) rather than a second maintained index — nothing here can
  // drift out of sync with it. In production this can only ever return zero
  // or one record today: EntryPackageApplicationService.createOrder()'s
  // scope-claim guard is unchanged by this method's existence and still
  // enforces single ownership. This exists so a repository-level test can
  // seed multiple same-side records directly (bypassing that guard) and
  // prove the repository layer itself has no single-owner assumption baked
  // in — see virtual-exposure-state spec.md.
  findActiveRecordsForScope(category: ExchangeInstrumentCategory, symbol: string): EntryPackageExecutionRecord[] {
    const targetScope = positionScopeKey(category, symbol);
    const results: EntryPackageExecutionRecord[] = [];

    for (const record of this.byCompositeKey.values()) {
      if (record.exchange_category !== "linear" && record.exchange_category !== "spot") {
        continue;
      }
      if (isDurablyClosedEntryPackageStatus(record.status)) {
        continue;
      }
      if (positionScopeKey(record.exchange_category, record.exchange_symbol) !== targetScope) {
        continue;
      }
      results.push(record);
    }

    return results;
  }

  async save(record: EntryPackageExecutionRecord): Promise<void> {
    const regression = fillFactRegression(
      this.byCompositeKey.get(correlationRecordKey(record.strategy_instance_id, record.trade_cycle_id)),
      record,
    );
    if (regression !== undefined) {
      throw new Error(regression);
    }

    const line = `${JSON.stringify(record)}\n`;

    const task = this.writeQueue.then(() => this.appendDurable(line));
    // A failed append must not wedge the queue for subsequent, unrelated
    // writes; the caller still observes the failure via `task` below.
    this.writeQueue = task.catch(() => undefined);
    await task;

    this.indexRecord(record);
    // Live-write-only scope claim/release. Correct here specifically because
    // live save() calls are already strictly
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
  // there.
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

  // Phase 2 of replay: evaluated once, after every line has been indexed
  // into byCompositeKey, using only each pair's final latest record — never
  // an intermediate one a later line for the same pair has since superseded.
  // byCompositeKey.values() yields exactly one record per pair, so a scope
  // collision found here is necessarily between two different pairs' latest
  // durable state, not a sequencing artifact.
  private rebuildScopeIndexFromReplay(): string | undefined {
    this.byScope.clear();

    for (const record of this.byCompositeKey.values()) {
      if (record.exchange_category !== "linear" && record.exchange_category !== "spot") {
        // "" is the valid never-bound shape (persistAbsentNoHistory) only
        // when durably closed. A non-durably-closed record with no real
        // exchange identity is a contradiction the current write paths
        // never produce (createOrder() always sets a real category before
        // any status other than absent) — but replay must fail closed
        // rather than silently exclude it from ownership if it ever does.
        if (!isDurablyClosedEntryPackageStatus(record.status)) {
          return (
            `record for ${correlationRecordKey(record.strategy_instance_id, record.trade_cycle_id)} has no real ` +
            `exchange binding (exchange_category=${JSON.stringify(record.exchange_category)}) but is not durably ` +
            `closed (status=${record.status})`
          );
        }
        continue;
      }

      if (record.exchange_symbol === "") {
        // Same contradiction for the symbol half of a real binding: a
        // "linear"/"spot" category implies createOrder() already
        // resolved a real symbol alongside it.
        if (!isDurablyClosedEntryPackageStatus(record.status)) {
          return (
            `record for ${correlationRecordKey(record.strategy_instance_id, record.trade_cycle_id)} has an empty ` +
            `exchange_symbol under category ${record.exchange_category} but is not durably closed ` +
            `(status=${record.status})`
          );
        }
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

// A pair's own recorded cumulative_filled_qty must never regress across
// writes: it is sourced from Bybit's own monotonic cumExecQty for that
// cycle's own entry order at every observation point
// (packageConfirmation.ts's toObservation), so no legitimate write can ever
// produce a smaller value than what is already durably recorded for the
// same pair. A violation is a programming-error signal, not a real business
// outcome (virtual-exposure-state spec.md, "Cumulative filled quantity
// never regresses"). average_execution_price is deliberately not checked —
// it is not required to move in any particular direction. Returns a
// descriptive reason on violation, undefined otherwise; callers decide
// whether to throw (live save()) or fail replay closed.
function fillFactRegression(
  previous: EntryPackageExecutionRecord | undefined,
  incoming: EntryPackageExecutionRecord,
): string | undefined {
  const previousObservation = previous?.early_execution_observation ?? null;
  const incomingObservation = incoming.early_execution_observation;
  if (previousObservation === null || incomingObservation === null) {
    return undefined;
  }

  if (compareDecimal(incomingObservation.cumulative_filled_qty, previousObservation.cumulative_filled_qty) < 0) {
    return (
      `cumulative_filled_qty regression for ` +
      `${correlationRecordKey(incoming.strategy_instance_id, incoming.trade_cycle_id)}: ` +
      `${incomingObservation.cumulative_filled_qty} < ${previousObservation.cumulative_filled_qty}`
    );
  }

  return undefined;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
