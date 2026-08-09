// ABI's structured operational-event emission boundary. Every event is one
// single-line JSON object written to stdout (info/warn) or stderr (error).
// service is fixed for this process and injected here, not caller-supplied
// — no call site can construct an event with a different service value.
export type EventLevel = "info" | "warn" | "error";

const SERVICE = "abi_executor_bot";

const RESERVED_EVENT_FIELDS = ["timestamp", "level", "service", "event"] as const;
type ReservedEventField = (typeof RESERVED_EVENT_FIELDS)[number];

// Compile-time boundary: a `fields` object that declares any reserved
// envelope key is rejected at the call site (its type for that key becomes
// `never`, so no real value can satisfy it).
type EventFields<T> = T & Partial<Record<ReservedEventField, never>>;

export function emitEvent<T extends Record<string, unknown> = Record<string, never>>(
  level: EventLevel,
  event: string,
  fields?: EventFields<T>,
): void {
  // Canonical values are applied after the caller-supplied fields, so they
  // always win at runtime too — even if a caller bypasses the compile-time
  // boundary above (an `any`-typed or externally-sourced fields object).
  const line = JSON.stringify({
    ...fields,
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE,
    event,
  });

  if (level === "error") {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

// Per-operation outcome vocabularies, derived directly from each domain
// module's own success-status and error-code literals
// (entryPackageApi.ts / openPositionApi.ts / positionManagementApi.ts) —
// not a new, parallel taxonomy invented for observability.
export type EntryPackageOperationOutcome = "entry_package_applied" | "entry_package_absent" | "internal_error";

export type OpenPositionOperationOutcome =
  | "position_open"
  | "position_closed"
  | "unknown_trade_cycle_binding"
  | "unsupported_exchange_scope"
  | "internal_error";

export type ProtectionOperationOutcome =
  | "protection_applied"
  | "position_not_open"
  | "unknown_trade_cycle_binding"
  | "unsupported_exchange_scope"
  | "internal_error";

export type CloseOperationOutcome =
  | "trade_cycle_closed"
  | "unknown_trade_cycle_binding"
  | "unsupported_exchange_scope"
  | "internal_error";

// Ties each execution operation to its own outcome union at the type
// level — the single source of truth `ExecutionOperation` and
// `withOperationEvents`'s `TOperation` inference both key off.
export type OperationOutcomeMap = {
  entry_package: EntryPackageOperationOutcome;
  open_position: OpenPositionOperationOutcome;
  protection: ProtectionOperationOutcome;
  close_position: CloseOperationOutcome;
};

export type ExecutionOperation = keyof OperationOutcomeMap;

type OperationIdentity<TOperation extends ExecutionOperation> = {
  operation: TOperation;
  strategyInstanceId: string;
  tradeCycleId: string;
};

type OperationClassification<TOperation extends ExecutionOperation> = {
  outcome: OperationOutcomeMap[TOperation];
  failed: boolean;
};

// Wraps one Runtime-facing execution operation invocation with
// operation_started, then exactly one terminal event. TOperation ties the
// classifier's returned `outcome` to that operation's own outcome union —
// a classifier that can return another operation's outcome does not
// type-check here. Classification is decided by `classify(result)`, not by
// resolve/reject alone — a service may itself catch an internal exception
// and normally return a typed internal_error result, which `classify` must
// map to `failed: true`. An uncaught throw/rejection reaching this wrapper
// is classified failed with outcome "internal_error" and rethrown
// unchanged — instrumentation never alters what the wrapped call returns
// or throws.
export async function withOperationEvents<TOperation extends ExecutionOperation, TResult>(
  identity: OperationIdentity<TOperation>,
  run: () => Promise<TResult>,
  classify: (result: TResult) => OperationClassification<TOperation>,
): Promise<TResult> {
  const startedAt = process.hrtime.bigint();
  const fields = {
    operation: identity.operation,
    strategy_instance_id: identity.strategyInstanceId,
    trade_cycle_id: identity.tradeCycleId,
  };

  emitEvent("info", "operation_started", fields);

  let result: TResult;
  try {
    result = await run();
  } catch (error) {
    emitEvent("error", "operation_failed", {
      ...fields,
      outcome: "internal_error",
      duration_ms: elapsedMs(startedAt),
    });
    throw error;
  }

  const { outcome, failed } = classify(result);
  emitEvent(failed ? "error" : "info", failed ? "operation_failed" : "operation_completed", {
    ...fields,
    outcome,
    duration_ms: elapsedMs(startedAt),
  });

  return result;
}

function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

// --- Per-operation classifiers -------------------------------------------
//
// Each classifier reads its operation's own existing HTTP response body
// type (no new vocabulary) and returns only that operation's outcome
// union. A handled business-negative body (e.g. position_not_open) is
// completed/info; a body reporting internal_error, or any transport-level
// error code that the owning application service's own apply()/resolve()
// never actually produces (malformed_json, unsupported_media_type,
// validation_failed — those originate earlier in the route, before the
// instrumentation boundary), is defensively classified failed/error rather
// than widening the outcome vocabulary to describe an unreachable case.

export function classifyEntryPackageResult(body: {
  status?: EntryPackageOperationOutcome;
  error?: { code: string };
}): OperationClassification<"entry_package"> {
  if (body.status !== undefined) {
    return { outcome: body.status, failed: false };
  }

  if (body.error?.code === "internal_error") {
    return { outcome: "internal_error", failed: true };
  }

  return { outcome: "internal_error", failed: true };
}

export function classifyProtectionResult(body: {
  status?: string;
  error?: { code: string };
}): OperationClassification<"protection"> {
  if (body.status === "protection_applied") {
    return { outcome: "protection_applied", failed: false };
  }

  switch (body.error?.code) {
    case "position_not_open":
    case "unknown_trade_cycle_binding":
    case "unsupported_exchange_scope":
      return { outcome: body.error.code, failed: false };
    case "internal_error":
      return { outcome: "internal_error", failed: true };
    default:
      return { outcome: "internal_error", failed: true };
  }
}

export function classifyCloseResult(body: {
  status?: string;
  error?: { code: string };
}): OperationClassification<"close_position"> {
  if (body.status === "trade_cycle_closed") {
    return { outcome: "trade_cycle_closed", failed: false };
  }

  switch (body.error?.code) {
    case "unknown_trade_cycle_binding":
    case "unsupported_exchange_scope":
      return { outcome: body.error.code, failed: false };
    case "internal_error":
      return { outcome: "internal_error", failed: true };
    default:
      return { outcome: "internal_error", failed: true };
  }
}

// open_position's success body carries a boolean (position_open), not a
// status literal — its existing true/false result is derived here into the
// position_open / position_closed observability outcomes design.md calls
// for, rather than inventing a separate business-outcome taxonomy.
export function classifyOpenPositionResult(body: {
  position_open?: boolean;
  error?: { code: string };
}): OperationClassification<"open_position"> {
  if (body.position_open !== undefined) {
    return { outcome: body.position_open ? "position_open" : "position_closed", failed: false };
  }

  switch (body.error?.code) {
    case "unknown_trade_cycle_binding":
    case "unsupported_exchange_scope":
      return { outcome: body.error.code, failed: false };
    case "internal_error":
      return { outcome: "internal_error", failed: true };
    default:
      return { outcome: "internal_error", failed: true };
  }
}
