// Exact-decimal arithmetic backed by BigInt so no step goes through binary
// floating point. Accepts the same grammar as entryPackageApi.ts's
// isExactDecimalText (optional sign, optional bare-leading/trailing-dot
// digits, optional exponent) — Runtime-supplied desired-entry fields are
// validated against that grammar at the transport layer, so this parser
// must not be stricter than it or a syntactically-valid request would fail
// arithmetic it should never have reached.
const EXACT_DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
const MAX_ABS_EXPONENT = 100;

type ParsedDecimal = {
  unscaled: bigint;
  scale: number;
};

function parseDecimal(text: string): ParsedDecimal {
  const match = EXACT_DECIMAL.exec(text);
  const integerPart = match?.[2] ?? "";
  const fractionPart = match?.[3] ?? "";

  if (match === null || (integerPart === "" && fractionPart === "")) {
    throw new Error(`not an exact-decimal string: ${text}`);
  }

  const negative = match[1] === "-";
  let unscaled = BigInt((integerPart || "0") + fractionPart);
  let scale = fractionPart.length;

  const exponentText = match[4];
  if (exponentText !== undefined) {
    const exponent = Number.parseInt(exponentText, 10);
    if (Math.abs(exponent) > MAX_ABS_EXPONENT) {
      throw new Error(`exact-decimal exponent out of supported range: ${text}`);
    }

    if (exponent >= scale) {
      unscaled *= pow10(exponent - scale);
      scale = 0;
    } else {
      scale -= exponent;
    }
  }

  return { unscaled: negative ? -unscaled : unscaled, scale };
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function floorDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator / denominator;
}

function formatScaled(unscaled: bigint, scale: number): string {
  const negative = unscaled < 0n;
  const abs = negative ? -unscaled : unscaled;
  const sign = negative ? "-" : "";

  if (scale === 0) {
    return `${sign}${abs.toString()}`;
  }

  const digits = abs.toString().padStart(scale + 1, "0");
  const integerPart = digits.slice(0, digits.length - scale);
  const fractionPart = digits.slice(digits.length - scale).replace(/0+$/, "");
  return fractionPart === "" ? `${sign}${integerPart}` : `${sign}${integerPart}.${fractionPart}`;
}

// ceil((numerator / denominator) / step) * step, computed exactly with
// integer arithmetic (no intermediate binary-float division).
export function ceilRatioToStep(numeratorText: string, denominatorText: string, stepText: string): string {
  const numerator = parseDecimal(numeratorText);
  const denominator = parseDecimal(denominatorText);
  const step = parseDecimal(stepText);

  const scaledNumerator = numerator.unscaled * pow10(denominator.scale + step.scale);
  const scaledDenominator = denominator.unscaled * pow10(numerator.scale) * step.unscaled;

  const steps = ceilDiv(scaledNumerator, scaledDenominator);
  return formatScaled(steps * step.unscaled, step.scale);
}

// ceil(value / step) * step
export function ceilToStep(valueText: string, stepText: string): string {
  return ceilRatioToStep(valueText, "1", stepText);
}

// floor(value / step) * step, computed exactly with integer arithmetic —
// same shape as ceilToStep, opposite rounding direction along the step
// grid (toward zero for a positive value, rather than away from it).
// An exact multiple of step is returned unchanged, matching ceilToStep.
export function floorToStep(valueText: string, stepText: string): string {
  const value = parseDecimal(valueText);
  const step = parseDecimal(stepText);

  const scale = Math.max(value.scale, step.scale);
  const scaledValue = value.unscaled * pow10(scale - value.scale);
  const scaledStep = step.unscaled * pow10(scale - step.scale);

  const steps = floorDiv(scaledValue, scaledStep);
  return formatScaled(steps * step.unscaled, step.scale);
}

export function maxDecimal(a: string, b: string): string {
  return compareDecimal(a, b) >= 0 ? a : b;
}

export function subtractDecimal(aText: string, bText: string): string {
  const a = parseDecimal(aText);
  const b = parseDecimal(bText);
  const scale = Math.max(a.scale, b.scale);
  const scaledA = a.unscaled * pow10(scale - a.scale);
  const scaledB = b.unscaled * pow10(scale - b.scale);
  const result = scaledA - scaledB;

  if (result < 0n) {
    throw new Error(`subtractDecimal produced a negative result: ${aText} - ${bText}`);
  }

  return formatScaled(result, scale);
}

export function compareDecimal(aText: string, bText: string): number {
  const a = parseDecimal(aText);
  const b = parseDecimal(bText);
  const scale = Math.max(a.scale, b.scale);
  const scaledA = a.unscaled * pow10(scale - a.scale);
  const scaledB = b.unscaled * pow10(scale - b.scale);

  if (scaledA === scaledB) {
    return 0;
  }
  return scaledA > scaledB ? 1 : -1;
}

// A canonical (sign, significant-digits, exponent) triple with no leading or
// trailing zeros in the digit string — two exact-decimal strings denote the
// same value iff their canonical triples are identical. Unlike parseDecimal,
// this never scales one operand up to match the other's magnitude (no
// `10n ** BigInt(hugeExponent)`), so it stays cheap no matter how large the
// text's exponent field is: only the exponent *number* grows, never a
// materialized power of ten.
type ExactDecimalCanonicalForm =
  | { zero: true }
  | { zero: false; negative: boolean; digits: string; exponent: number };

function canonicalizeExactDecimal(text: string): ExactDecimalCanonicalForm | undefined {
  const match = EXACT_DECIMAL.exec(text);
  const integerPart = match?.[2] ?? "";
  const fractionPart = match?.[3] ?? "";

  if (match === null || (integerPart === "" && fractionPart === "")) {
    return undefined;
  }

  const negative = match[1] === "-";

  let exponent = -fractionPart.length;
  const exponentText = match[4];
  if (exponentText !== undefined) {
    const exponentField = Number.parseInt(exponentText, 10);
    if (!Number.isSafeInteger(exponentField)) {
      return undefined;
    }
    exponent += exponentField;
  }

  let digits = integerPart + fractionPart;
  if (/^0*$/.test(digits)) {
    return { zero: true };
  }

  let start = 0;
  while (start < digits.length - 1 && digits[start] === "0") {
    start += 1;
  }
  digits = digits.slice(start);

  let end = digits.length;
  while (end > 1 && digits[end - 1] === "0") {
    end -= 1;
    exponent += 1;
  }
  digits = digits.slice(0, end);

  if (!Number.isSafeInteger(exponent)) {
    return undefined;
  }

  return { zero: false, negative, digits, exponent };
}

// Total (never throws) numeric equality over the full exact-decimal grammar
// isExactDecimalText accepts, including exponents far outside
// MAX_ABS_EXPONENT's arithmetic bound — comparison never needs to scale
// either operand by 10^exponent, so no such bound applies here. Formatting
// differences (trailing zeros, a leading '+', an equivalent exponent form)
// never affect the result; a malformed or unparseable operand makes the
// comparison false rather than throwing.
export function decimalEquals(aText: string, bText: string): boolean {
  const a = canonicalizeExactDecimal(aText);
  const b = canonicalizeExactDecimal(bText);

  if (a === undefined || b === undefined) {
    return false;
  }

  if (a.zero || b.zero) {
    return a.zero && b.zero;
  }

  return a.negative === b.negative && a.digits === b.digits && a.exponent === b.exponent;
}
