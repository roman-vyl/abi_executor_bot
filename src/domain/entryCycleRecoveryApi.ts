import type { DesiredEntryDto, EntryPackageValidationDetail } from "./entryPackageApi.js";
import { isExactDecimalText, isPositiveExactDecimalText } from "./entryPackageApi.js";

export type RecoveryState =
  | "entry_order_live"
  | "entry_order_not_found"
  | "position_open"
  | "terminal_without_fill"
  | "terminal_after_fill";

export type AppliedEntryPackage = {
  applied_desired_entry: DesiredEntryDto;
  calculated_quantity: string;
};

export type RecoveryStateSuccessResponse = {
  recovery_state: RecoveryState;
  applied_entry_package: AppliedEntryPackage | null;
  first_fill_at_ms: number | null;
  average_entry_price: string | null;
};

export type RecoveryStateErrorCode = "validation_failed" | "unknown_trade_cycle_binding" | "internal_error";

export type RecoveryStateErrorResponse = {
  error: {
    code: RecoveryStateErrorCode;
    message: string;
    details?: EntryPackageValidationDetail[];
  };
};

export type RecoveryStateResponseBody = RecoveryStateSuccessResponse | RecoveryStateErrorResponse;

export type RecoveryStateHttpResult = {
  statusCode: 200 | 422 | 500;
  body: RecoveryStateResponseBody;
};

// entry_order_live: the applied entry package is included (a caller can
// reconstruct its own aggregate), but no fill facts exist yet — the order
// has not filled.
export function entryOrderLiveResult(input: {
  appliedDesiredEntry: DesiredEntryDto;
  calculatedQuantity: string;
}): RecoveryStateHttpResult {
  if (!isExactDecimalText(input.calculatedQuantity)) {
    return internalErrorResult();
  }

  return {
    statusCode: 200,
    body: {
      recovery_state: "entry_order_live",
      applied_entry_package: {
        applied_desired_entry: input.appliedDesiredEntry,
        calculated_quantity: input.calculatedQuantity,
      },
      first_fill_at_ms: null,
      average_entry_price: null,
    },
  };
}

export function entryOrderNotFoundResult(): RecoveryStateHttpResult {
  return {
    statusCode: 200,
    body: {
      recovery_state: "entry_order_not_found",
      applied_entry_package: null,
      first_fill_at_ms: null,
      average_entry_price: null,
    },
  };
}

// position_open: the applied entry package AND fill facts are both
// present — this is the one state carrying every field this response shape
// defines.
export function positionOpenResult(input: {
  appliedDesiredEntry: DesiredEntryDto;
  calculatedQuantity: string;
  firstFillAtMs: number;
  averageEntryPrice: string;
}): RecoveryStateHttpResult {
  if (
    !isExactDecimalText(input.calculatedQuantity) ||
    !Number.isInteger(input.firstFillAtMs) ||
    input.firstFillAtMs <= 0 ||
    !isPositiveExactDecimalText(input.averageEntryPrice)
  ) {
    return internalErrorResult();
  }

  return {
    statusCode: 200,
    body: {
      recovery_state: "position_open",
      applied_entry_package: {
        applied_desired_entry: input.appliedDesiredEntry,
        calculated_quantity: input.calculatedQuantity,
      },
      first_fill_at_ms: input.firstFillAtMs,
      average_entry_price: input.averageEntryPrice,
    },
  };
}

// terminal_without_fill / terminal_after_fill: both omit the applied entry
// package and every fill fact — the binding this trade cycle held is over,
// and there is nothing live left to reconstruct.
export function terminalWithoutFillResult(): RecoveryStateHttpResult {
  return terminalResult("terminal_without_fill");
}

export function terminalAfterFillResult(): RecoveryStateHttpResult {
  return terminalResult("terminal_after_fill");
}

function terminalResult(recoveryState: "terminal_without_fill" | "terminal_after_fill"): RecoveryStateHttpResult {
  return {
    statusCode: 200,
    body: {
      recovery_state: recoveryState,
      applied_entry_package: null,
      first_fill_at_ms: null,
      average_entry_price: null,
    },
  };
}

export function validationFailedResult(details: EntryPackageValidationDetail[]): RecoveryStateHttpResult {
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

export function unknownTradeCycleBindingResult(): RecoveryStateHttpResult {
  return errorResult(422, "unknown_trade_cycle_binding", "no correlation record exists for the requested pair");
}

// The single safe-error shape for every non-positive resolution: a genuine
// query failure/malformed response, and a clean-but-empty result everywhere,
// are deliberately indistinguishable to the caller — both mean the same
// thing (retry later, no state is resolved yet), per this capability's
// central absence-of-evidence rule.
export function internalErrorResult(): RecoveryStateHttpResult {
  return errorResult(500, "internal_error", "internal error");
}

// Mirrors openPositionApi.ts's decodeOpaquePathValue: percent-decodes one
// opaque path segment and rejects it if decoding fails or it decodes empty.
export function decodeOpaquePathValue(
  value: string,
  path: string,
  details: EntryPackageValidationDetail[],
): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    details.push({ path, message: "path value must use valid percent encoding" });
    return undefined;
  }

  if (decoded.length === 0) {
    details.push({ path, message: "path value must be a non-empty string" });
    return undefined;
  }

  return decoded;
}

function errorResult(
  statusCode: 422 | 500,
  code: Exclude<RecoveryStateErrorCode, "validation_failed">,
  message: string,
): RecoveryStateHttpResult {
  return {
    statusCode,
    body: {
      error: { code, message },
    },
  };
}
