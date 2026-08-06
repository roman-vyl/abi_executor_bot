import type { EntryPackageValidationDetail } from "./entryPackageApi.js";
import { isExactDecimalText } from "./entryPackageApi.js";
import { compareDecimal } from "./exactDecimal.js";

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

export type CloseCommand = {
  strategyInstanceId: string;
  tradeCycleId: string;
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
    if (typeof value !== "string" || !isExactDecimalText(value)) {
      details.push({
        path: "/stop_price",
        message: "stop_price must be exact-decimal text",
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
    } else if (typeof value !== "string" || !isExactDecimalText(value)) {
      details.push({
        path: "/take_price",
        message: "take_price must be exact-decimal text or null",
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

// The comparison confirmation will use once execution wiring supplies an
// exchange-reported value (spec: "Protection confirmation requires exact
// numeric equality, not exchange acceptance") — string formatting
// differences (trailing zeros, leading '+') must not block confirmation,
// only a genuine value change may. Reuses exactDecimal.ts's compareDecimal
// rather than reimplementing arithmetic; total (never throws), so a
// malformed exchange-reported value reads as a mismatch, not an uncaught
// exception.
export function isNumericallyEqualExactDecimal(a: string, b: string): boolean {
  try {
    return compareDecimal(a, b) === 0;
  } catch {
    return false;
  }
}

export function serializeProtectionApplied(input: {
  strategyInstanceId: string;
  tradeCycleId: string;
  stopPrice: string;
  takePrice: string | null;
}): PositionManagementHttpResult {
  if (
    input.strategyInstanceId.length === 0 ||
    input.tradeCycleId.length === 0 ||
    !isExactDecimalText(input.stopPrice) ||
    (input.takePrice !== null && !isExactDecimalText(input.takePrice))
  ) {
    return internalErrorResult();
  }

  return {
    statusCode: 200,
    body: {
      strategy_instance_id: input.strategyInstanceId,
      trade_cycle_id: input.tradeCycleId,
      status: "protection_applied",
      stop_price: input.stopPrice,
      take_price: input.takePrice,
    },
  };
}

export function serializeTradeCycleClosed(input: {
  strategyInstanceId: string;
  tradeCycleId: string;
}): PositionManagementHttpResult {
  if (input.strategyInstanceId.length === 0 || input.tradeCycleId.length === 0) {
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

// Reused verbatim from abi-open-position-lookup-api (design.md Decision 1):
// same code, same meaning, same HTTP status — not a parallel vocabulary.
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
