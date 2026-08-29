import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { compareDecimal } from "../domain/exactDecimal.js";
import {
  directionalPositionSlotKey,
  instrumentPositionScope,
  instrumentPositionScopeKey,
  type DirectionalPositionSlot,
  type InstrumentPositionScope,
} from "../domain/positionScope.js";
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

      // Durable rows written before abi-pair-scoped-close-execution-v1
      // shipped have no close_order_link_id/close_order_id keys at all.
      // Normalizing a missing key to null here — before validation, before
      // indexing — guarantees every in-memory record matches its declared
      // `string | null` type exactly, never `undefined`; downstream close
      // logic reads these fields as `!== null` without also having to
      // check for `undefined` at every call site. Not a schema migration:
      // nothing is rewritten on disk, only the in-memory value read this
      // one time.
      normalizeLegacyCloseIdentityFields(parsed);
      normalizeLegacyPositionBindingMode(parsed);

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
    const conflict = this.validateOwnershipViewsFromReplay();
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

  // Authoritative multi-owner instrument view. Scanning the latest record
  // per pair avoids a second mutable ownership store and cannot discard
  // siblings. It intentionally includes one-way owners and both future
  // hedge directions because foundation admission remains instrument-wide.
  findActiveRecordsForInstrumentScope(scope: InstrumentPositionScope): EntryPackageExecutionRecord[] {
    const targetScope = instrumentPositionScopeKey(scope);
    const results: EntryPackageExecutionRecord[] = [];

    for (const record of this.byCompositeKey.values()) {
      if (record.exchange_category !== "linear" && record.exchange_category !== "spot") {
        continue;
      }
      if (isDurablyClosedEntryPackageStatus(record.status)) {
        continue;
      }
      if (
        instrumentPositionScopeKey(instrumentPositionScope(record.exchange_category, record.exchange_symbol)) !==
        targetScope
      ) {
        continue;
      }
      results.push(record);
    }

    return results;
  }

  // Directional physical slots exist only for records whose actual durable
  // geometry is hedge. One-way records remain instrument-scoped and never
  // alias long or short merely because their virtual desired entry has a side.
  findActiveRecordsForDirectionalSlot(slot: DirectionalPositionSlot): EntryPackageExecutionRecord[] {
    const targetSlot = directionalPositionSlotKey(slot);
    return this.findActiveRecordsForInstrumentScope(slot.instrumentScope).filter((record) => {
      if (record.position_binding_mode !== "hedge" || record.desired_entry === null) {
        return false;
      }
      return (
        directionalPositionSlotKey({
          instrumentScope: slot.instrumentScope,
          direction: record.desired_entry.side,
        }) === targetSlot
      );
    });
  }

  async save(record: EntryPackageExecutionRecord): Promise<void> {
    if (record.position_binding_mode !== "one_way" && record.position_binding_mode !== "hedge") {
      throw new Error("current correlation writes require an explicit position_binding_mode");
    }
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

  // Phase 2 of replay: evaluated once, after every line has been indexed
  // into byCompositeKey, using only each pair's final latest record — never
  // an intermediate one a later line for the same pair has since superseded.
  // byCompositeKey.values() yields exactly one record per pair, so a scope
  // collision found here is necessarily between two different pairs' latest
  // durable state, not a sequencing artifact.
  private validateOwnershipViewsFromReplay(): string | undefined {
    // These local derived views prove instrument and directional-slot
    // identities can be reconstructed without another durable store. The
    // canonical query methods continue scanning the latest pair records.
    const activeSideByInstrument = new Map<string, "long" | "short">();
    const activeOwnerKeysByDirectionalSlot = new Map<string, Set<string>>();

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

      if (record.position_binding_mode === null) {
        return (
          `active_legacy_one_way_record_requires_drain for ` +
          `${correlationRecordKey(record.strategy_instance_id, record.trade_cycle_id)}`
        );
      }

      if (record.position_binding_mode === "hedge" && record.exchange_category !== "linear") {
        return (
          `active hedge binding for ${correlationRecordKey(record.strategy_instance_id, record.trade_cycle_id)} ` +
          `uses unsupported category ${record.exchange_category}`
        );
      }

      const scope = instrumentPositionScope(record.exchange_category, record.exchange_symbol);
      const scopeKey = instrumentPositionScopeKey(scope);

      const side = record.desired_entry?.side;
      if (side === undefined) {
        // Same contradiction class as the missing-exchange-binding checks
        // above: a non-durably-closed record with no usable desired_entry
        // is a state no current write path produces, but replay must fail
        // closed rather than silently exclude it from ownership if it ever
        // does.
        return (
          `record for ${correlationRecordKey(record.strategy_instance_id, record.trade_cycle_id)} is active but ` +
          `has no usable desired_entry.side`
        );
      }

      if (record.position_binding_mode === "hedge") {
        const slotKey = directionalPositionSlotKey({ instrumentScope: scope, direction: side });
        const owners = activeOwnerKeysByDirectionalSlot.get(slotKey) ?? new Set<string>();
        owners.add(correlationRecordKey(record.strategy_instance_id, record.trade_cycle_id));
        activeOwnerKeysByDirectionalSlot.set(slotKey, owners);
      }

      const existingSide = activeSideByInstrument.get(scopeKey);
      if (existingSide !== undefined && existingSide !== side) {
        return (
          `unsupported_mixed_side_active_state for ${scopeKey}: ` +
          `(saw both "${existingSide}" and "${side}")`
        );
      }
      activeSideByInstrument.set(scopeKey, side);
    }

    return undefined;
  }
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
  if (
    previous !== undefined &&
    previous.position_binding_mode !== null &&
    previous.generation === incoming.generation &&
    incoming.position_binding_mode !== previous.position_binding_mode
  ) {
    return (
      `position_binding_mode changed within generation for ` +
      `${correlationRecordKey(incoming.strategy_instance_id, incoming.trade_cycle_id)}: ` +
      `${JSON.stringify(previous.position_binding_mode)} -> ${JSON.stringify(incoming.position_binding_mode)}`
    );
  }

  // first_fill_at_ms is a strict immutability check (not monotonic
  // non-decrease like cumulative_filled_qty below): once captured
  // (abi-pair-scoped-open-position-resolution-v1), it must never change,
  // including changing to null. Checked independently of
  // early_execution_observation's own nullity.
  const previousFirstFillAtMs = previous?.first_fill_at_ms ?? null;
  if (previousFirstFillAtMs !== null && incoming.first_fill_at_ms !== previousFirstFillAtMs) {
    return (
      `first_fill_at_ms regression for ` +
      `${correlationRecordKey(incoming.strategy_instance_id, incoming.trade_cycle_id)}: ` +
      `${JSON.stringify(incoming.first_fill_at_ms)} !== ${JSON.stringify(previousFirstFillAtMs)}`
    );
  }

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

// Mutates a freshly JSON.parse()'d value in place, filling in a missing
// close_order_link_id/close_order_id key with null. Only ever called on a
// value that has not yet been validated or indexed, before any other code
// holds a reference to it — see the call site's comment in replay().
function normalizeLegacyCloseIdentityFields(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const record = value as Record<string, unknown>;
  if (!("close_order_link_id" in record)) {
    record.close_order_link_id = null;
  }
  if (!("close_order_id" in record)) {
    record.close_order_id = null;
  }
  // Same precedent, for rows written before
  // abi-pair-scoped-open-position-resolution-v1 shipped.
  if (!("first_fill_at_ms" in record)) {
    record.first_fill_at_ms = null;
  }
}

// Missing means a record was written before this foundation, when every
// real binding used one-way positionIdx 0. null preserves that provenance
// in memory; it is never written by current save() calls.
function normalizeLegacyPositionBindingMode(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const record = value as Record<string, unknown>;
  if (!("position_binding_mode" in record)) {
    record.position_binding_mode = null;
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
