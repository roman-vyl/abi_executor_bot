export type DesiredEntryDto = {
  side: "long" | "short";
  source_plan_bar_open_time_ms: number;
  planned_entry_price: string;
  initial_stop_price: string;
  initial_take_price: string;
  locked_exit_profile: string;
};

export type EntryPackageRequestBody = {
  ticker: string;
  desired_entry: DesiredEntryDto | null;
  risk_multiplier: string;
};

export type EntryPackageCommand = {
  strategyInstanceId: string;
  tradeCycleId: string;
  ticker: string;
  desiredEntry: DesiredEntryDto | null;
  riskMultiplier: string;
};

export type EntryPackageAppliedResponse = {
  strategy_instance_id: string;
  trade_cycle_id: string;
  status: "entry_package_applied";
  applied_desired_entry: DesiredEntryDto;
  accepted_risk_multiplier: string;
  calculated_quantity: string;
};

export type EntryPackageAbsentResponse = {
  strategy_instance_id: string;
  trade_cycle_id: string;
  status: "entry_package_absent";
};

export type EntryPackageValidationDetail = {
  path: string;
  message: string;
};

export type EntryPackageErrorCode =
  | "malformed_json"
  | "unsupported_media_type"
  | "validation_failed"
  | "internal_error";

export type EntryPackageErrorResponse = {
  error: {
    code: EntryPackageErrorCode;
    message: string;
    details?: EntryPackageValidationDetail[];
  };
};

export type EntryPackageResponseBody =
  | EntryPackageAppliedResponse
  | EntryPackageAbsentResponse
  | EntryPackageErrorResponse;

export type EntryPackageHttpResult = {
  statusCode: 200 | 400 | 415 | 422 | 500;
  body: EntryPackageResponseBody;
};

export type EntryPackageValidationResult =
  | {
      ok: true;
      command: EntryPackageCommand;
    }
  | {
      ok: false;
      details: EntryPackageValidationDetail[];
    };

export type AppliedAcknowledgementInput = {
  strategyInstanceId: string;
  tradeCycleId: string;
  completePackageApplied: boolean;
  appliedDesiredEntry: DesiredEntryDto;
  acceptedRiskMultiplier: string;
  calculatedQuantity: string;
};

export function validateEntryPackageCommand(
  path: {
    strategyInstanceId: unknown;
    tradeCycleId: unknown;
  },
  payload: unknown,
): EntryPackageValidationResult {
  const details: EntryPackageValidationDetail[] = [];

  validateOpaqueNonEmptyString(
    path.strategyInstanceId,
    "/path/strategy_instance_id",
    "strategy_instance_id",
    details,
  );
  validateOpaqueNonEmptyString(
    path.tradeCycleId,
    "/path/trade_cycle_id",
    "trade_cycle_id",
    details,
  );

  if (!isRecord(payload)) {
    details.push({
      path: "/",
      message: "request body must be a JSON object",
    });
    return { ok: false, details };
  }

  validateClosedObject(payload, ["ticker", "desired_entry", "risk_multiplier"], "/", details);

  if (Object.hasOwn(payload, "ticker")) {
    validateOpaqueNonEmptyString(payload.ticker, "/ticker", "ticker", details);
  }

  const hasDesiredEntry = Object.hasOwn(payload, "desired_entry");
  const hasRiskMultiplier = Object.hasOwn(payload, "risk_multiplier");
  const desiredEntryValue = payload.desired_entry;
  const riskMultiplierValue = payload.risk_multiplier;

  let desiredEntry: DesiredEntryDto | null = null;
  if (hasDesiredEntry && desiredEntryValue !== null) {
    const desiredEntryResult = validateDesiredEntry(desiredEntryValue);
    if (desiredEntryResult.ok) {
      desiredEntry = desiredEntryResult.value;
    } else {
      details.push(...desiredEntryResult.details);
    }
  }

  let riskMultiplier: string | undefined;
  if (hasRiskMultiplier) {
    if (typeof riskMultiplierValue !== "string") {
      details.push({
        path: "/risk_multiplier",
        message: "risk_multiplier must be a positive exact-decimal string",
      });
    } else if (!isPositiveExactDecimalText(riskMultiplierValue)) {
      details.push({
        path: "/risk_multiplier",
        message: "risk_multiplier must be positive exact-decimal text",
      });
    } else {
      riskMultiplier = riskMultiplierValue;
    }
  }

  if (details.length > 0 || riskMultiplier === undefined) {
    return { ok: false, details };
  }

  return {
    ok: true,
    command: {
      strategyInstanceId: path.strategyInstanceId as string,
      tradeCycleId: path.tradeCycleId as string,
      ticker: payload.ticker as string,
      desiredEntry,
      riskMultiplier,
    },
  };
}

export function serializeAppliedEntryPackage(
  input: AppliedAcknowledgementInput,
): EntryPackageHttpResult {
  if (!input.completePackageApplied) {
    return internalErrorResult();
  }

  const desiredEntryResult = validateDesiredEntry(input.appliedDesiredEntry);
  if (
    input.strategyInstanceId.length === 0 ||
    input.tradeCycleId.length === 0 ||
    !desiredEntryResult.ok ||
    !isPositiveExactDecimalText(input.acceptedRiskMultiplier) ||
    !isExactDecimalText(input.calculatedQuantity)
  ) {
    return internalErrorResult();
  }

  return {
    statusCode: 200,
    body: {
      strategy_instance_id: input.strategyInstanceId,
      trade_cycle_id: input.tradeCycleId,
      status: "entry_package_applied",
      applied_desired_entry: desiredEntryResult.value,
      accepted_risk_multiplier: input.acceptedRiskMultiplier,
      calculated_quantity: input.calculatedQuantity,
    },
  };
}

export function serializeAbsentEntryPackage(input: {
  strategyInstanceId: string;
  tradeCycleId: string;
}): EntryPackageHttpResult {
  if (input.strategyInstanceId.length === 0 || input.tradeCycleId.length === 0) {
    return internalErrorResult();
  }

  return {
    statusCode: 200,
    body: {
      strategy_instance_id: input.strategyInstanceId,
      trade_cycle_id: input.tradeCycleId,
      status: "entry_package_absent",
    },
  };
}

export function malformedJsonResult(): EntryPackageHttpResult {
  return errorResult(400, "malformed_json", "request body must be valid JSON");
}

export function unsupportedMediaTypeResult(): EntryPackageHttpResult {
  return errorResult(415, "unsupported_media_type", "content-type must be application/json");
}

export function validationFailedResult(
  details: EntryPackageValidationDetail[],
): EntryPackageHttpResult {
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

export function internalErrorResult(): EntryPackageHttpResult {
  return errorResult(500, "internal_error", "internal error");
}

export function isSupportedJsonContentType(value: string | string[] | undefined): boolean {
  if (typeof value !== "string") {
    return false;
  }

  return /^[\t ]*application\/json(?:[\t ]*;[\t ]*charset[\t ]*=[\t ]*(?:utf-8|"utf-8"))?[\t ]*$/i.test(
    value,
  );
}

export function isExactDecimalText(value: string): boolean {
  return analyzeExactDecimalText(value).valid;
}

export function isPositiveExactDecimalText(value: string): boolean {
  const result = analyzeExactDecimalText(value);
  return result.valid && result.positive;
}

function validateDesiredEntry(
  value: unknown,
):
  | {
      ok: true;
      value: DesiredEntryDto;
    }
  | {
      ok: false;
      details: EntryPackageValidationDetail[];
    } {
  const details: EntryPackageValidationDetail[] = [];

  if (!isRecord(value)) {
    return {
      ok: false,
      details: [
        {
          path: "/desired_entry",
          message: "desired_entry must be a JSON object or null",
        },
      ],
    };
  }

  validateClosedObject(
    value,
    [
      "side",
      "source_plan_bar_open_time_ms",
      "planned_entry_price",
      "initial_stop_price",
      "initial_take_price",
      "locked_exit_profile",
    ],
    "/desired_entry",
    details,
  );

  if (Object.hasOwn(value, "side") && value.side !== "long" && value.side !== "short") {
    details.push({
      path: "/desired_entry/side",
      message: "side must be long or short",
    });
  }

  if (
    Object.hasOwn(value, "source_plan_bar_open_time_ms") &&
    (typeof value.source_plan_bar_open_time_ms !== "number" ||
      !Number.isInteger(value.source_plan_bar_open_time_ms))
  ) {
    details.push({
      path: "/desired_entry/source_plan_bar_open_time_ms",
      message: "source_plan_bar_open_time_ms must be a JSON integer",
    });
  }

  validateExactDecimalField(
    value,
    "planned_entry_price",
    "/desired_entry/planned_entry_price",
    false,
    details,
  );
  validateExactDecimalField(
    value,
    "initial_stop_price",
    "/desired_entry/initial_stop_price",
    false,
    details,
  );
  validateExactDecimalField(
    value,
    "initial_take_price",
    "/desired_entry/initial_take_price",
    true,
    details,
  );

  if (Object.hasOwn(value, "locked_exit_profile") && typeof value.locked_exit_profile !== "string") {
    details.push({
      path: "/desired_entry/locked_exit_profile",
      message: "locked_exit_profile must be a string",
    });
  }

  if (details.length > 0) {
    return { ok: false, details };
  }

  return {
    ok: true,
    value: {
      side: value.side as "long" | "short",
      source_plan_bar_open_time_ms: value.source_plan_bar_open_time_ms as number,
      planned_entry_price: value.planned_entry_price as string,
      initial_stop_price: value.initial_stop_price as string,
      initial_take_price: value.initial_take_price as string,
      locked_exit_profile: value.locked_exit_profile as string,
    },
  };
}

function validateExactDecimalField(
  value: Record<string, unknown>,
  field: string,
  path: string,
  positive: boolean,
  details: EntryPackageValidationDetail[],
): void {
  if (!Object.hasOwn(value, field)) {
    return;
  }

  const fieldValue = value[field];
  const valid =
    typeof fieldValue === "string" &&
    (positive ? isPositiveExactDecimalText(fieldValue) : isExactDecimalText(fieldValue));

  if (!valid) {
    details.push({
      path,
      message: positive
        ? `${field} must be positive exact-decimal text`
        : `${field} must be exact-decimal text`,
    });
  }
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

function analyzeExactDecimalText(value: string): {
  valid: boolean;
  positive: boolean;
} {
  if (value.length === 0) {
    return { valid: false, positive: false };
  }

  let index = 0;
  let negative = false;
  if (value[index] === "+" || value[index] === "-") {
    negative = value[index] === "-";
    index += 1;
  }

  let digitCount = 0;
  let coefficientHasNonZeroDigit = false;

  while (index < value.length && isDigit(value[index])) {
    coefficientHasNonZeroDigit ||= value[index] !== "0";
    digitCount += 1;
    index += 1;
  }

  if (value[index] === ".") {
    index += 1;
    while (index < value.length && isDigit(value[index])) {
      coefficientHasNonZeroDigit ||= value[index] !== "0";
      digitCount += 1;
      index += 1;
    }
  }

  if (digitCount === 0) {
    return { valid: false, positive: false };
  }

  if (value[index] === "e" || value[index] === "E") {
    index += 1;
    if (value[index] === "+" || value[index] === "-") {
      index += 1;
    }

    const exponentStart = index;
    while (index < value.length && isDigit(value[index])) {
      index += 1;
    }
    if (index === exponentStart) {
      return { valid: false, positive: false };
    }
  }

  if (index !== value.length) {
    return { valid: false, positive: false };
  }

  return {
    valid: true,
    positive: !negative && coefficientHasNonZeroDigit,
  };
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function errorResult(
  statusCode: 400 | 415 | 500,
  code: Exclude<EntryPackageErrorCode, "validation_failed">,
  message: string,
): EntryPackageHttpResult {
  return {
    statusCode,
    body: {
      error: {
        code,
        message,
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
