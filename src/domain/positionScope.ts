import type { ExchangeInstrumentCategory } from "../exchange/exchangeInstrumentResolver.js";

// A physical Bybit position scope: one exchange category + symbol, under
// the single Bybit account configured for this ABI process, always
// one-way positionIdx 0. Account and positionIdx are deliberately not part
// of this type or its key — V1 has exactly one configured account per
// process (config.ts) and supports only one-way mode (validated elsewhere,
// e.g. open-position-resolution's positionIdx==0 check), so neither is a
// dimension a scope key needs to vary over yet (position-scope-exclusivity
// design.md Decision 1). Extending this type with an accountId is additive
// if that V1 boundary is ever lifted.
export type PositionScope = {
  category: ExchangeInstrumentCategory;
  symbol: string;
};

export function positionScopeKey(category: ExchangeInstrumentCategory, symbol: string): string {
  return `${category}:${symbol}`;
}
