import type { EntryPackageValidationDetail } from "./entryPackageApi.js";
import { isPositiveExactDecimalText } from "./entryPackageApi.js";

export type OpenPositionSuccessResponse =
  | {
      position_open: true;
      first_fill_at_ms: number;
      average_entry_price: string;
    }
  | {
      position_open: false;
      first_fill_at_ms: null;
      average_entry_price: null;
    };

export type OpenPositionErrorCode =
  | "validation_failed"
  | "unknown_trade_cycle_binding"
  | "unsupported_exchange_scope"
  | "internal_error";

export type OpenPositionErrorResponse = {
  error: {
    code: OpenPositionErrorCode;
    message: string;
    details?: EntryPackageValidationDetail[];
  };
};

export type OpenPositionResponseBody = OpenPositionSuccessResponse | OpenPositionErrorResponse;

export type OpenPositionHttpResult = {
  statusCode: 200 | 422 | 500;
  body: OpenPositionResponseBody;
};

// Only constructor for an open-position success DTO — enforces the
// cross-field invariant (both facts present, or both null) at construction
// time rather than trusting callers to keep the two fields in sync.
export function openPositionOpenResult(input: {
  firstFillAtMs: number;
  averageEntryPrice: string;
}): OpenPositionHttpResult {
  if (
    !Number.isInteger(input.firstFillAtMs) ||
    input.firstFillAtMs <= 0 ||
    !isPositiveExactDecimalText(input.averageEntryPrice)
  ) {
    return internalErrorResult();
  }

  return {
    statusCode: 200,
    body: {
      position_open: true,
      first_fill_at_ms: input.firstFillAtMs,
      average_entry_price: input.averageEntryPrice,
    },
  };
}

export function openPositionClosedResult(): OpenPositionHttpResult {
  return {
    statusCode: 200,
    body: {
      position_open: false,
      first_fill_at_ms: null,
      average_entry_price: null,
    },
  };
}

export function validationFailedResult(details: EntryPackageValidationDetail[]): OpenPositionHttpResult {
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

export function unknownTradeCycleBindingResult(): OpenPositionHttpResult {
  return errorResult(422, "unknown_trade_cycle_binding", "no correlation record exists for the requested pair");
}

export function unsupportedExchangeScopeResult(): OpenPositionHttpResult {
  return errorResult(422, "unsupported_exchange_scope", "record's exchange category is not supported");
}

export function internalErrorResult(): OpenPositionHttpResult {
  return errorResult(500, "internal_error", "internal error");
}

// Mirrors entryPackageRoutes.ts's decodePathValue, extended with the
// empty-after-decoding check inline: this route has no request body to
// carry a second validation phase, so percent-decoding and the emptiness
// check for each opaque path segment both happen here (design.md Decision 7).
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
  code: Exclude<OpenPositionErrorCode, "validation_failed">,
  message: string,
): OpenPositionHttpResult {
  return {
    statusCode,
    body: {
      error: { code, message },
    },
  };
}
