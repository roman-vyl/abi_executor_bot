// ABI's structured operational-event emission boundary. Every event is one
// single-line JSON object written to stdout (info/warn) or stderr (error).
// service is fixed for this process and injected here, not caller-supplied
// — no call site can construct an event with a different service value.
export type EventLevel = "info" | "warn" | "error";

const SERVICE = "abi_executor_bot";

export function emitEvent(level: EventLevel, event: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE,
    event,
    ...fields,
  });

  if (level === "error") {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

export type ExecutionOperation = "entry_package" | "open_position" | "protection" | "close_position";

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

type OperationIdentity = {
  operation: ExecutionOperation;
  strategyInstanceId: string;
  tradeCycleId: string;
};

type OperationClassification = {
  outcome: string;
  failed: boolean;
};

// Wraps one Runtime-facing execution operation invocation with
// operation_started, then exactly one terminal event. Classification is
// decided by `classify(result)`, not by resolve/reject alone — a service
// may itself catch an internal exception and normally return a typed
// internal_error result, which `classify` must map to `failed: true`. An
// uncaught throw/rejection reaching this wrapper is classified failed with
// outcome "internal_error" and rethrown unchanged — instrumentation never
// alters what the wrapped call returns or throws.
export async function withOperationEvents<TResult>(
  identity: OperationIdentity,
  run: () => Promise<TResult>,
  classify: (result: TResult) => OperationClassification,
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

// entry_package, protection, and close_position all share the same
// {status} | {error: {code}} HTTP result shape — a normal typed return
// (including a handled business-negative error code) is operation_completed;
// only error.code === "internal_error" is operation_failed. Derived directly
// from each domain module's own result/error-code types, not a new
// parallel vocabulary.
export function classifyStatusResult(body: { status: string } | { error: { code: string } }): OperationClassification {
  if ("status" in body) {
    return { outcome: body.status, failed: false };
  }

  return { outcome: body.error.code, failed: body.error.code === "internal_error" };
}

// open_position's success body carries a boolean (position_open), not a
// status literal — its existing true/false result is derived here into the
// position_open / position_closed observability outcomes design.md calls
// for, rather than inventing a separate business-outcome taxonomy.
export function classifyOpenPositionResult(
  body: { position_open: boolean } | { error: { code: string } },
): OperationClassification {
  if ("error" in body) {
    return { outcome: body.error.code, failed: body.error.code === "internal_error" };
  }

  return { outcome: body.position_open ? "position_open" : "position_closed", failed: false };
}
