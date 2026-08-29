import type { InstrumentPositionScope, PositionBindingGeometry } from "../domain/positionScope.js";
import type { BybitAdapter } from "./bybitAdapter.js";
import { encodeBybitPositionIdx } from "./bybitOrderMapper.js";

export type PositionModeAssuranceOutcome =
  | { kind: "verified" }
  | { kind: "mismatch" }
  | { kind: "unavailable" };

// Read-only assurance used by hedge startup/admission. It accepts an
// explicit internal expectation and never switches exchange position mode.
export async function assureBybitPositionMode(input: {
  bybit: BybitAdapter;
  instrumentScope: InstrumentPositionScope;
  expected: PositionBindingGeometry;
}): Promise<PositionModeAssuranceOutcome> {
  let response: unknown;
  try {
    response = await input.bybit.getOpenPositions({
      category: input.instrumentScope.category,
      symbol: input.instrumentScope.symbol,
    });
  } catch {
    return { kind: "unavailable" };
  }

  if (!isRecord(response) || response.retCode !== 0 || !isRecord(response.result)) {
    return { kind: "unavailable" };
  }
  const result = response.result;
  if (result.category !== input.instrumentScope.category || !Array.isArray(result.list) || result.list.length === 0) {
    return { kind: "unavailable" };
  }

  const indexes = new Set<number>();
  for (const item of result.list) {
    if (!isRecord(item) || item.symbol !== input.instrumentScope.symbol) {
      return { kind: "unavailable" };
    }
    const index = item.positionIdx;
    if (typeof index !== "number" || !Number.isInteger(index) || ![0, 1, 2].includes(index) || indexes.has(index)) {
      return { kind: "unavailable" };
    }
    indexes.add(index);
  }

  if (input.expected.mode === "one_way") {
    return indexes.size === 1 && indexes.has(0) ? { kind: "verified" } : { kind: "mismatch" };
  }

  const expectedIndex = encodeBybitPositionIdx(input.expected);
  if (indexes.has(0)) {
    return { kind: "mismatch" };
  }
  if (![...indexes].every((index) => index === 1 || index === 2)) {
    return { kind: "unavailable" };
  }
  // Missing target-slot evidence is not flat proof. The controlled caller
  // must assure the exact directional binding it is about to use.
  return indexes.has(expectedIndex) ? { kind: "verified" } : { kind: "unavailable" };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
