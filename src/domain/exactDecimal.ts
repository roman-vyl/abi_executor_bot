// Exact-decimal arithmetic on plain (non-exponential) positive decimal
// strings, backed by BigInt so no step goes through binary floating point.
// Matches the discipline already established by entryPackageApi.ts's
// isExactDecimalText, but restricted to the plain-digit subset that Bybit
// instrument rules and entry-package prices/quantities actually use.

const PLAIN_POSITIVE_DECIMAL = /^\d+(\.\d+)?$/;

type ParsedDecimal = {
  unscaled: bigint;
  scale: number;
};

function parseDecimal(text: string): ParsedDecimal {
  if (!PLAIN_POSITIVE_DECIMAL.test(text)) {
    throw new Error(`not a plain positive exact-decimal string: ${text}`);
  }

  const [integerPart, fractionPart = ""] = text.split(".");
  const unscaled = BigInt(integerPart + fractionPart);
  return { unscaled, scale: fractionPart.length };
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function formatScaled(unscaled: bigint, scale: number): string {
  if (scale === 0) {
    return unscaled.toString();
  }

  const digits = unscaled.toString().padStart(scale + 1, "0");
  const integerPart = digits.slice(0, digits.length - scale);
  const fractionPart = digits.slice(digits.length - scale).replace(/0+$/, "");
  return fractionPart === "" ? integerPart : `${integerPart}.${fractionPart}`;
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
