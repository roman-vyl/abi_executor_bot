import type { DesiredEntryDto } from "./entryPackageApi.js";
import type { ExchangeInstrumentCategory } from "../exchange/exchangeInstrumentResolver.js";

// The configured exchange account is operationally part of both identities
// below, but remains implicit because one ABI process still owns exactly one
// account. Keeping the account out of the public shape is not a claim that
// two accounts share positions; multi-account execution remains unsupported.
export type InstrumentPositionScope = {
  category: ExchangeInstrumentCategory;
  symbol: string;
};

export type PositionDirection = DesiredEntryDto["side"];

export type DirectionalPositionSlot = {
  instrumentScope: InstrumentPositionScope;
  direction: PositionDirection;
};

export function instrumentPositionScope(
  category: ExchangeInstrumentCategory,
  symbol: string,
): InstrumentPositionScope {
  return { category, symbol };
}

export function directionalPositionSlot(
  instrumentScope: InstrumentPositionScope,
  direction: PositionDirection,
): DirectionalPositionSlot {
  return { instrumentScope, direction };
}

// JSON array keys avoid delimiter collisions for opaque exchange symbols and
// keep instrument and directional-slot namespaces structurally distinct.
export function instrumentPositionScopeKey(scope: InstrumentPositionScope): string {
  return JSON.stringify(["instrument", scope.category, scope.symbol]);
}

export function directionalPositionSlotKey(slot: DirectionalPositionSlot): string {
  return JSON.stringify([
    "directional-slot",
    slot.instrumentScope.category,
    slot.instrumentScope.symbol,
    slot.direction,
  ]);
}
