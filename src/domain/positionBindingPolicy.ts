import type { PositionBindingMode } from "../correlation/entryPackageExecutionRecord.js";
import type { ExchangeInstrumentCategory } from "../exchange/exchangeInstrumentResolver.js";
import type { PositionBindingGeometry, PositionDirection } from "./positionScope.js";

export type LinearPositionBindingPolicy = PositionBindingMode;

export function effectivePositionBindingMode(
  category: ExchangeInstrumentCategory,
  linearPolicy: LinearPositionBindingPolicy,
): PositionBindingMode {
  return category === "linear" ? linearPolicy : "one_way";
}

export function positionBindingGeometryForNewGeneration(
  category: ExchangeInstrumentCategory,
  side: PositionDirection,
  linearPolicy: LinearPositionBindingPolicy,
): PositionBindingGeometry {
  return effectivePositionBindingMode(category, linearPolicy) === "hedge"
    ? { mode: "hedge", direction: side }
    : { mode: "one_way" };
}
