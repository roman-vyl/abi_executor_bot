import type { KeyedMutex } from "../../concurrency/keyedMutex.js";
import type { EntryPackageCorrelationRepository } from "../../correlation/entryPackageCorrelationRepository.js";
import type {
  EntryPackageExecutionRecord,
  EntryPackageExecutionStatus,
} from "../../correlation/entryPackageExecutionRecord.js";
import { correlationRecordKey, isDurablyClosedEntryPackageStatus } from "../../correlation/entryPackageExecutionRecord.js";
import { compareDecimal } from "../../domain/exactDecimal.js";
import type { DesiredEntryDto } from "../../domain/entryPackageApi.js";
import type { OpenPositionHttpResult } from "../../domain/openPositionApi.js";
import {
  internalErrorResult,
  openPositionClosedResult,
  openPositionOpenResult,
  unknownTradeCycleBindingResult,
  unsupportedExchangeScopeResult,
} from "../../domain/openPositionApi.js";
import type { BybitAdapter, BybitOrderSide } from "../../exchange/bybitAdapter.js";
import { confirmEntryPackage, isFillFactFinal, resolveFirstAttributableFillAtMs } from "../entryPackage/packageConfirmation.js";

export type OpenPositionQuery = {
  strategyInstanceId: string;
  tradeCycleId: string;
};

export type OpenPositionResolutionServiceDeps = {
  correlationRepository: EntryPackageCorrelationRepository;
  bybit: BybitAdapter;
  // Used only by resolve() (the GET HTTP path), to durably capture
  // first_fill_at_ms exactly once — the same shared instance
  // EntryPackageApplicationService/ProtectionApplicationService/
  // CloseApplicationService already use. determine() itself never touches
  // this — see its own doc comment for why (deadlock avoidance against
  // ProtectionApplicationService's existing call, which already holds it).
  mutex: KeyedMutex;
};

type StatusBucket = "durably_closed" | "live_query_admissible" | "unresolved";

// The discriminated outcome of determining whether a given record's own
// trade cycle currently holds an open position, independent of any HTTP
// response shape — shared by this service's own GET .../open-position
// wrapper (resolve()) and by protection's live-position gate, so own-cycle
// fill sourcing, aggregate sanity, and category/side-match rules are
// defined exactly once.
export type PositionDetermination =
  | {
      kind: "open";
      // Verbatim pass-through of record.first_fill_at_ms — null if this
      // cycle's own fill has been proven but the durable capture has not
      // happened yet. determine() never computes or captures this itself;
      // only resolve() does (abi-pair-scoped-open-position-resolution-v1
      // design.md Decision 5).
      firstFillAtMs: number | null;
      averageEntryPrice: string;
      // Sourced from the same live-position query used for the aggregate
      // sanity check — protection's already-satisfied comparison reuses
      // these rather than issuing a second query. Undefined means the
      // exchange reported no exact-decimal value for that leg, not that it
      // is zero.
      confirmedStopLoss?: string;
      confirmedTakeProfit?: string;
    }
  | { kind: "closed" }
  | { kind: "unsupported_scope" }
  | { kind: "error" };

type NonOpenDetermination = Exclude<PositionDetermination, { kind: "open" }>;

// Resolves a truthful, live current open-position answer for one
// (strategy_instance_id, trade_cycle_id) pair, sourced from this cycle's
// own attributable execution evidence.
//
// Attribution: position_open, average_entry_price, and first_fill_at_ms are
// all sourced from this cycle's own entry order's own fill facts — never
// from the aggregate physical position, which cannot distinguish owners
// once a scope is shared (abi-pair-scoped-open-position-resolution-v1). The
// aggregate live Bybit query is retained only as weak sanity (existence +
// side compatibility, a plausibility check against this record's own
// declared intent, not proof of attribution) and to supply
// PUT .../protection's confirmed stop/take values.
export class OpenPositionResolutionService {
  private readonly deps: OpenPositionResolutionServiceDeps;

  constructor(deps: OpenPositionResolutionServiceDeps) {
    this.deps = deps;
  }

  async resolve(query: OpenPositionQuery): Promise<OpenPositionHttpResult> {
    const record = this.deps.correlationRepository.get(query.strategyInstanceId, query.tradeCycleId);

    if (record === undefined) {
      return unknownTradeCycleBindingResult();
    }

    if (classifyStatus(record.status) !== "live_query_admissible") {
      // durably_closed/unresolved outcomes need no lock and no durable
      // write — byte-for-byte the same code path as before this change.
      const determination = await this.determine(record);
      return determination.kind === "open" ? internalErrorResult() : this.buildNonOpenHttpResult(determination);
    }

    const key = correlationRecordKey(query.strategyInstanceId, query.tradeCycleId);
    return this.deps.mutex.withKeyLock(key, () => this.resolveLiveQueryAdmissible(query));
  }

  // The shared live-position determination other callers (protection
  // execution) reuse directly against an already-resolved record, rather
  // than going through resolve()'s HTTP-shaping, its own composite lookup,
  // and its mutex a second time. Lock-free and side-effect-free by design:
  // ProtectionApplicationService.process() already calls this directly
  // while holding the same pair-level mutex for its own entire request, so
  // this method must never acquire it internally (would deadlock), and
  // never durably writes anything (protection never reads firstFillAtMs
  // from the result, so it would cost that caller nothing it needs, but
  // durable capture belongs to resolve()'s single call site instead — see
  // design.md Decision 5).
  async determine(record: EntryPackageExecutionRecord): Promise<PositionDetermination> {
    const bucket = classifyStatus(record.status);

    if (bucket === "durably_closed") {
      return { kind: "closed" };
    }

    if (bucket === "unresolved") {
      return { kind: "error" };
    }

    if (record.exchange_category !== "linear") {
      return { kind: "unsupported_scope" };
    }

    const ownFacts = await this.resolveOwnFillFacts(record);
    if (ownFacts === undefined) {
      return { kind: "error" };
    }

    if (compareDecimal(ownFacts.cumulativeFilledQty, "0") <= 0) {
      // No aggregate query is made: nothing the aggregate could say would
      // change this cycle's own answer, and skipping it removes a concrete
      // false-positive risk (a stale or, later, sibling aggregate row
      // happening to side-match while this cycle's own order has not
      // filled).
      return { kind: "closed" };
    }

    if (ownFacts.avgExecutionPrice === undefined) {
      // Structurally impossible-to-serve state: this cycle's own evidence
      // proves a fill but carries no usable average price. Never
      // fabricated, estimated, or substituted.
      return { kind: "error" };
    }

    const queryResult = await this.deps.bybit.queryPositionForInstrument({
      category: record.exchange_category,
      symbol: record.exchange_symbol,
    });

    if (queryResult.kind === "failure" || queryResult.kind === "no_position") {
      // Own evidence proves a fill, but the aggregate sanity check
      // disagrees (query failure or no matching row) — fails closed rather
      // than reporting position_open from own evidence alone.
      return { kind: "error" };
    }

    if (!sideMatches(queryResult.row.side, record.desired_entry)) {
      return { kind: "error" };
    }

    return {
      kind: "open",
      firstFillAtMs: record.first_fill_at_ms,
      averageEntryPrice: ownFacts.avgExecutionPrice,
      confirmedStopLoss: queryResult.row.stopLoss,
      confirmedTakeProfit: queryResult.row.takeProfit,
    };
  }

  // Resolves this cycle's own cumulative fill facts: reuses the stored,
  // already-final observation with no exchange call when possible;
  // otherwise performs one fresh, read-only query of this cycle's own
  // entry order — the same confirmEntryPackage primitive
  // resolveOwnExposure (abi-pair-scoped-close-execution-v1) already
  // established for this exact "already final -> reuse; otherwise refresh"
  // shape, applied here for a read instead of a write.
  private async resolveOwnFillFacts(
    record: EntryPackageExecutionRecord,
  ): Promise<{ cumulativeFilledQty: string; avgExecutionPrice: string | undefined } | undefined> {
    const observation = record.early_execution_observation;
    if (observation !== null && isFillFactFinal(observation)) {
      return {
        cumulativeFilledQty: observation.cumulative_filled_qty,
        avgExecutionPrice: observation.avg_execution_price,
      };
    }

    const calculatedQuantity = record.calculated_quantity;
    const orderLinkId = record.order_link_id;
    const category = record.exchange_category;
    if (calculatedQuantity === null || orderLinkId === null || category !== "linear") {
      return undefined;
    }

    const symbol = record.exchange_symbol;
    const confirmation = await confirmEntryPackage({
      bybit: this.deps.bybit,
      getEntryOrderPayload: { category, symbol, orderLinkId, limit: "1" as const },
      getEntryOrderHistoryPayload: { category, symbol, orderLinkId, limit: "1" as const },
      expected: { qty: calculatedQuantity },
    });

    if (confirmation.kind === "full_fill" || confirmation.kind === "partial_fill") {
      return {
        cumulativeFilledQty: confirmation.observation.cumulative_filled_qty,
        avgExecutionPrice: confirmation.observation.avg_execution_price,
      };
    }
    if (confirmation.kind === "terminal_without_fill") {
      return { cumulativeFilledQty: "0", avgExecutionPrice: undefined };
    }
    if (confirmation.kind === "pending_confirmed") {
      // Entry order live but zero own cumulative fill so far — a normal,
      // expected state for a conditional/unfilled entry (e.g. Untriggered),
      // not an error. Reported the same as terminal_without_fill here:
      // zero fill facts, which determine() correctly turns into "closed"
      // (position_open=false), never "open" and never fabricated.
      return { cumulativeFilledQty: "0", avgExecutionPrice: undefined };
    }
    // "not_found" / "ambiguous": still treated as unresolved/error — no
    // fill evidence obtainable at all, as opposed to pending_confirmed's
    // definite zero-fill live order.
    return undefined;
  }

  // Runs entirely under the pair mutex: re-reads the record fresh
  // (authoritative — a concurrent close may have durably closed it since
  // resolve()'s outer, unlocked read), calls the lock-free determine(), and
  // — only when this cycle's own evidence proves an open position and
  // first_fill_at_ms is not yet durably captured — performs the one and
  // only capture of it in this entire codebase.
  private async resolveLiveQueryAdmissible(query: OpenPositionQuery): Promise<OpenPositionHttpResult> {
    const record = this.deps.correlationRepository.get(query.strategyInstanceId, query.tradeCycleId);
    if (record === undefined) {
      return unknownTradeCycleBindingResult();
    }

    const determination = await this.determine(record);

    if (determination.kind !== "open") {
      return this.buildNonOpenHttpResult(determination);
    }

    if (record.first_fill_at_ms !== null) {
      return openPositionOpenResult({
        firstFillAtMs: record.first_fill_at_ms,
        averageEntryPrice: determination.averageEntryPrice,
      });
    }

    if (record.order_link_id === null || record.exchange_category !== "linear") {
      return internalErrorResult();
    }

    const captured = await resolveFirstAttributableFillAtMs({
      bybit: this.deps.bybit,
      category: record.exchange_category,
      symbol: record.exchange_symbol,
      orderLinkId: record.order_link_id,
    });

    if (captured.kind !== "found") {
      // "no_executions_found" (own evidence already proves a fill, so this
      // is a contradiction, never proof of no fill) or "ambiguous" — never
      // fabricated or omitted.
      return internalErrorResult();
    }

    try {
      await this.deps.correlationRepository.save({
        ...record,
        first_fill_at_ms: captured.firstFillAtMs,
        updated_at: new Date().toISOString(),
      });
    } catch {
      // A durable-write failure (e.g. a disk error) does not convert an
      // otherwise-successful determination into an error response — the
      // freshly-captured value is still truthful in this moment. The next
      // GET retries the capture, since first_fill_at_ms was never durably
      // set.
    }

    return openPositionOpenResult({
      firstFillAtMs: captured.firstFillAtMs,
      averageEntryPrice: determination.averageEntryPrice,
    });
  }

  private buildNonOpenHttpResult(determination: NonOpenDetermination): OpenPositionHttpResult {
    switch (determination.kind) {
      case "closed":
        return openPositionClosedResult();
      case "unsupported_scope":
        return unsupportedExchangeScopeResult();
      case "error":
        return internalErrorResult();
      default:
        return exhaustiveNonOpenDetermination(determination);
    }
  }
}

function classifyStatus(status: EntryPackageExecutionStatus): StatusBucket {
  if (isDurablyClosedEntryPackageStatus(status)) {
    return "durably_closed";
  }

  switch (status) {
    case "applied":
    case "pending_replace":
    case "pending_cancel":
      return "live_query_admissible";
    case "pending_create":
    case "create_failed":
    case "unknown":
      return "unresolved";
    default:
      return exhaustive(status);
  }
}

function sideMatches(rowSide: BybitOrderSide, desiredEntry: DesiredEntryDto | null): boolean {
  if (desiredEntry === null) {
    return false;
  }

  return (
    (rowSide === "Buy" && desiredEntry.side === "long") || (rowSide === "Sell" && desiredEntry.side === "short")
  );
}

function exhaustive(value: never): never {
  throw new Error(`Unhandled EntryPackageExecutionStatus: ${JSON.stringify(value)}`);
}

function exhaustiveNonOpenDetermination(value: never): never {
  throw new Error(`Unhandled PositionDetermination: ${JSON.stringify(value)}`);
}
