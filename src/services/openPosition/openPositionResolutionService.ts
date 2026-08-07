import type { EntryPackageCorrelationRepository } from "../../correlation/entryPackageCorrelationRepository.js";
import type {
  EntryPackageExecutionRecord,
  EntryPackageExecutionStatus,
} from "../../correlation/entryPackageExecutionRecord.js";
import { isDurablyClosedEntryPackageStatus } from "../../correlation/entryPackageExecutionRecord.js";
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

export type OpenPositionQuery = {
  strategyInstanceId: string;
  tradeCycleId: string;
};

export type OpenPositionResolutionServiceDeps = {
  correlationRepository: EntryPackageCorrelationRepository;
  bybit: BybitAdapter;
};

type StatusBucket = "durably_closed" | "live_query_admissible" | "unresolved";

// The discriminated outcome of determining whether a given record's
// physical scope currently holds a live position, independent of any HTTP
// response shape — shared by this service's own GET .../open-position
// wrapper (resolve()) and by protection-execution's live-position gate
// (protection-execution design.md Decision 4), so Bybit position-envelope
// validation and category/side-match rules are defined exactly once.
export type PositionDetermination =
  | { kind: "open"; firstFillAtMs: number; averageEntryPrice: string }
  | { kind: "closed" }
  | { kind: "unsupported_scope" }
  | { kind: "error" };

// Resolves a truthful, live current open-position answer for one
// (strategy_instance_id, trade_cycle_id) pair (design.md Decisions 1-6).
//
// V1 attribution operating precondition (design.md Decision 9): the live
// Bybit query is scoped to category+symbol under the deployment's
// configured API credentials and carries no Runtime/ABI order-binding
// identity. The symbol+side check below is only a plausibility check
// against the resolved record's own declared intent, not proof that the
// reported exposure was caused by this record's own order. Correct
// attribution for V1 depends on no overlapping manual or other-strategy
// exposure existing concurrently on the same exchange_symbol under those
// credentials — this is not detected, enforced, or verified here.
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

    const determination = await this.determine(record);

    switch (determination.kind) {
      case "closed":
        return openPositionClosedResult();
      case "unsupported_scope":
        return unsupportedExchangeScopeResult();
      case "error":
        return internalErrorResult();
      case "open":
        return openPositionOpenResult({
          firstFillAtMs: determination.firstFillAtMs,
          averageEntryPrice: determination.averageEntryPrice,
        });
      default:
        return exhaustiveDetermination(determination);
    }
  }

  // The shared live-position determination other callers (protection
  // execution) reuse directly against an already-resolved record, rather
  // than going through resolve()'s HTTP-shaping and its own composite
  // lookup a second time.
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

    const queryResult = await this.deps.bybit.queryPositionForInstrument({
      category: record.exchange_category,
      symbol: record.exchange_symbol,
    });

    if (queryResult.kind === "failure") {
      return { kind: "error" };
    }

    if (queryResult.kind === "no_position") {
      return { kind: "closed" };
    }

    if (!sideMatches(queryResult.row.side, record.desired_entry)) {
      return { kind: "error" };
    }

    return {
      kind: "open",
      firstFillAtMs: queryResult.row.openTime,
      averageEntryPrice: queryResult.row.avgPrice,
    };
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

function exhaustiveDetermination(value: never): never {
  throw new Error(`Unhandled PositionDetermination: ${JSON.stringify(value)}`);
}
