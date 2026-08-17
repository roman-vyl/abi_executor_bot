import type { EntryPackageValidationDetail } from "./entryPackageApi.js";
import { isExactDecimalText, isPositiveExactDecimalText } from "./entryPackageApi.js";
import { decimalEquals } from "./exactDecimal.js";

export type ProtectionRequestBody = {
  stop_price: string;
  take_price: string | null;
};

export type ProtectionCommand = {
  strategyInstanceId: string;
  tradeCycleId: string;
  stopPrice: string;
  takePrice: string | null;
};

export type ProtectionAppliedResponse = {
  strategy_instance_id: string;
  trade_cycle_id: string;
  status: "protection_applied";
  stop_price: string;
  take_price: string | null;
};

// V1 accepts only a canonical exposureFraction — an exact-decimal string
// numerically equal to "1" (validateCloseCommand enforces this; any other
// value never reaches a CloseCommand at all). No caller-supplied absolute
// quantity is ever accepted here — ABI resolves that itself.
export type CloseCommand = {
  strategyInstanceId: string;
  tradeCycleId: string;
  exposureFraction: string;
};

export type TradeCycleClosedResponse = {
  strategy_instance_id: string;
  trade_cycle_id: string;
  status: "trade_cycle_closed";
};

export type PositionManagementErrorCode =
  | "malformed_json"
  | "unsupported_media_type"
  | "validation_failed"
  | "unknown_trade_cycle_binding"
  | "unsupported_exchange_scope"
  | "position_not_open"
  | "close_execution_incomplete"
  | "internal_error";

export type PositionManagementErrorResponse = {
  error: {
    code: PositionManagementErrorCode;
    message: string;
    details?: EntryPackageValidationDetail[];
  };
};

export type PositionManagementResponseBody =
  | ProtectionAppliedResponse
  | TradeCycleClosedResponse
  | PositionManagementErrorResponse;

export type PositionManagementHttpResult = {
  statusCode: 200 | 400 | 415 | 422 | 500;
  body: PositionManagementResponseBody;
};

export type ProtectionValidationResult =
  | {
      ok: true;
      command: ProtectionCommand;
    }
  | {
      ok: false;
      details: EntryPackageValidationDetail[];
    };

export type CloseValidationResult =
  | {
      ok: true;
      command: CloseCommand;
    }
  | {
      ok: false;
      details: EntryPackageValidationDetail[];
    };

export function validateProtectionCommand(
  path: {
    strategyInstanceId: unknown;
    tradeCycleId: unknown;
  },
  payload: unknown,
): ProtectionValidationResult {
  const details: EntryPackageValidationDetail[] = [];

  validateOpaqueNonEmptyString(
    path.strategyInstanceId,
    "/path/strategy_instance_id",
    "strategy_instance_id",
    details,
  );
  validateOpaqueNonEmptyString(path.tradeCycleId, "/path/trade_cycle_id", "trade_cycle_id", details);

  if (!isRecord(payload)) {
    details.push({
      path: "/",
      message: "request body must be a JSON object",
    });
    return { ok: false, details };
  }

  validateClosedObject(payload, ["stop_price", "take_price"], "/", details);

  let stopPrice: string | undefined;
  if (Object.hasOwn(payload, "stop_price")) {
    const value = payload.stop_price;
    if (typeof value !== "string" || !isPositiveExactDecimalText(value)) {
      details.push({
        path: "/stop_price",
        message: "stop_price must be strictly positive exact-decimal text",
      });
    } else {
      stopPrice = value;
    }
  }

  let takePrice: string | null | undefined;
  if (Object.hasOwn(payload, "take_price")) {
    const value = payload.take_price;
    if (value === null) {
      takePrice = null;
    } else if (typeof value !== "string" || !isPositiveExactDecimalText(value)) {
      details.push({
        path: "/take_price",
        message: "take_price must be strictly positive exact-decimal text or null",
      });
    } else {
      takePrice = value;
    }
  }

  if (details.length > 0 || stopPrice === undefined || takePrice === undefined) {
    return { ok: false, details };
  }

  return {
    ok: true,
    command: {
      strategyInstanceId: path.strategyInstanceId as string,
      tradeCycleId: path.tradeCycleId as string,
      stopPrice,
      takePrice,
    },
  };
}

// Builds the close endpoint's command independently of whatever the route's
// own path-matching already checked — the domain layer validates its own
// inputs rather than trusting a caller's prior pass (mirrors
// validateProtectionCommand's independent path-opaqueness check). The body
// is validated the same way validateProtectionCommand validates its own:
// exposure_fraction must be present, exact-decimal text, and numerically
// equal to 1 (decimalEquals, not literal string equality — "1.0" is
// accepted the same way it is for stop_price/take_price elsewhere in this
// file) — any other value, malformed text, a missing/null field, or an
// unrecognized extra field fails closed here, before CloseApplicationService
// is ever invoked, before any exchange call or durable write.
export function validateCloseCommand(
  path: {
    strategyInstanceId: unknown;
    tradeCycleId: unknown;
  },
  payload: unknown,
): CloseValidationResult {
  const details: EntryPackageValidationDetail[] = [];

  validateOpaqueNonEmptyString(
    path.strategyInstanceId,
    "/path/strategy_instance_id",
    "strategy_instance_id",
    details,
  );
  validateOpaqueNonEmptyString(path.tradeCycleId, "/path/trade_cycle_id", "trade_cycle_id", details);

  if (!isRecord(payload)) {
    details.push({
      path: "/",
      message: "request body must be a JSON object",
    });
    return { ok: false, details };
  }

  validateClosedObject(payload, ["exposure_fraction"], "/", details);

  let exposureFraction: string | undefined;
  if (Object.hasOwn(payload, "exposure_fraction")) {
    const value = payload.exposure_fraction;
    if (typeof value !== "string" || !isExactDecimalText(value) || !decimalEquals(value, "1")) {
      details.push({
        path: "/exposure_fraction",
        message: 'exposure_fraction must be exact-decimal text numerically equal to "1"',
      });
    } else {
      exposureFraction = value;
    }
  }

  if (details.length > 0 || exposureFraction === undefined) {
    return { ok: false, details };
  }

  return {
    ok: true,
    command: {
      strategyInstanceId: path.strategyInstanceId as string,
      tradeCycleId: path.tradeCycleId as string,
      exposureFraction,
    },
  };
}

// Protection confirmation requires exact numeric equality, not mere exchange
// acceptance: string formatting differences (trailing zeros, leading '+')
// must not block confirmation, only a genuine value change may. Delegates to
// exactDecimal.ts's decimalEquals, which is total (never throws) and does not
// scale by 10^exponent, so an arbitrarily large exponent never gets rejected
// as "out of range" the way transport's own grammar never bounded it either.
export function isNumericallyEqualExactDecimal(a: string, b: string): boolean {
  return decimalEquals(a, b);
}

// Everything serializeProtectionApplied needs to prove the 2xx is earned,
// not merely that its own fields are well-formed: the accepted request's
// stop/take (what the response echoes back), the exchange's independently
// confirmed stop/take (what proves the write actually took effect), and an
// explicit flag that verification itself ran to completion — a caller that
// hasn't finished verifying has no business calling this at all, but the
// type still makes that state representable so it fails closed rather than
// being assumed away.
export type ProtectionConfirmation = {
  strategyInstanceId: string;
  tradeCycleId: string;
  acceptedStopPrice: string;
  acceptedTakePrice: string | null;
  confirmedStopPrice: string;
  confirmedTakePrice: string | null;
  verificationSucceeded: boolean;
};

export function serializeProtectionApplied(input: ProtectionConfirmation): PositionManagementHttpResult {
  if (
    !input.verificationSucceeded ||
    input.strategyInstanceId.length === 0 ||
    input.tradeCycleId.length === 0 ||
    !isPositiveExactDecimalText(input.acceptedStopPrice) ||
    !isPositiveExactDecimalText(input.confirmedStopPrice) ||
    (input.acceptedTakePrice !== null && !isPositiveExactDecimalText(input.acceptedTakePrice)) ||
    (input.confirmedTakePrice !== null && !isPositiveExactDecimalText(input.confirmedTakePrice)) ||
    (input.acceptedTakePrice === null) !== (input.confirmedTakePrice === null) ||
    !isNumericallyEqualExactDecimal(input.acceptedStopPrice, input.confirmedStopPrice) ||
    (input.acceptedTakePrice !== null &&
      input.confirmedTakePrice !== null &&
      !isNumericallyEqualExactDecimal(input.acceptedTakePrice, input.confirmedTakePrice))
  ) {
    return internalErrorResult();
  }

  // The response echoes what Runtime submitted, never the exchange's
  // confirmed value or formatting — confirmedStopPrice/confirmedTakePrice
  // exist only to gate this branch, not to appear in the body.
  return {
    statusCode: 200,
    body: {
      strategy_instance_id: input.strategyInstanceId,
      trade_cycle_id: input.tradeCycleId,
      status: "protection_applied",
      stop_price: input.acceptedStopPrice,
      take_price: input.acceptedTakePrice,
    },
  };
}

// Close success requires all three postconditions to be verified under
// complete pair correlation: zero position, no attributed active entry order,
// and internally consistent correlation. All three must be independently
// true, not merely absent/undefined, before a 2xx is possible.
export type CloseConfirmation = {
  strategyInstanceId: string;
  tradeCycleId: string;
  positionZeroVerified: boolean;
  noAttributedActiveOrdersVerified: boolean;
  correlationCompleteAndConsistent: boolean;
};

export function serializeTradeCycleClosed(input: CloseConfirmation): PositionManagementHttpResult {
  if (
    input.strategyInstanceId.length === 0 ||
    input.tradeCycleId.length === 0 ||
    !input.positionZeroVerified ||
    !input.noAttributedActiveOrdersVerified ||
    !input.correlationCompleteAndConsistent
  ) {
    return internalErrorResult();
  }

  return {
    statusCode: 200,
    body: {
      strategy_instance_id: input.strategyInstanceId,
      trade_cycle_id: input.tradeCycleId,
      status: "trade_cycle_closed",
    },
  };
}

export function malformedJsonResult(): PositionManagementHttpResult {
  return errorResult(400, "malformed_json", "request body must be valid JSON");
}

export function unsupportedMediaTypeResult(): PositionManagementHttpResult {
  return errorResult(415, "unsupported_media_type", "content-type must be application/json");
}

export function validationFailedResult(
  details: EntryPackageValidationDetail[],
): PositionManagementHttpResult {
  if (details.length === 0) {
    return internalErrorResult();
  }

  return {
    statusCode: 422,
    body: {
      error: {
        code: "validation_failed",
        message: "request validation failed",
        details,
      },
    },
  };
}

// Reused from open-position lookup: same code, same meaning, same HTTP
// status — not a parallel vocabulary.
export function unknownTradeCycleBindingResult(): PositionManagementHttpResult {
  return errorResult(422, "unknown_trade_cycle_binding", "no correlation record exists for the requested pair");
}

export function unsupportedExchangeScopeResult(): PositionManagementHttpResult {
  return errorResult(
    422,
    "unsupported_exchange_scope",
    "resolved position's exchange category is not supported",
  );
}

export function positionNotOpenResult(): PositionManagementHttpResult {
  return errorResult(422, "position_not_open", "no live position exists for the requested pair");
}

// Close-only: the requested cycle's own close order (multi-owner path)
// reached a terminal outcome whose confirmed executed quantity does not
// exactly equal the quantity ABI resolved and submitted for it — zero
// execution (rejected/cancelled) and partial execution both land here,
// differing only in degree. Never sent for the single-owner path, which has
// no comparable per-cycle quantity to fall short of.
export function closeExecutionIncompleteResult(): PositionManagementHttpResult {
  return errorResult(
    422,
    "close_execution_incomplete",
    "the requested cycle's own close order did not fully execute the resolved exposure",
  );
}

export function internalErrorResult(): PositionManagementHttpResult {
  return errorResult(500, "internal_error", "internal error");
}

function validateOpaqueNonEmptyString(
  value: unknown,
  path: string,
  name: string,
  details: EntryPackageValidationDetail[],
): void {
  if (typeof value !== "string" || value.length === 0) {
    details.push({
      path,
      message: `${name} must be a non-empty string`,
    });
  }
}

function validateClosedObject(
  value: Record<string, unknown>,
  fields: string[],
  path: string,
  details: EntryPackageValidationDetail[],
): void {
  const allowed = new Set(fields);

  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      details.push({
        path: joinJsonPointer(path, key),
        message: "unknown field",
      });
    }
  }

  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      details.push({
        path: joinJsonPointer(path, field),
        message: "field is required",
      });
    }
  }
}

function joinJsonPointer(base: string, key: string): string {
  const escaped = key.replaceAll("~", "~0").replaceAll("/", "~1");
  return base === "/" ? `/${escaped}` : `${base}/${escaped}`;
}

function errorResult(
  statusCode: 400 | 415 | 422 | 500,
  code: Exclude<PositionManagementErrorCode, "validation_failed">,
  message: string,
): PositionManagementHttpResult {
  return {
    statusCode,
    body: {
      error: { code, message },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
