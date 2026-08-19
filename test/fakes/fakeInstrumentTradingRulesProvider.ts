import type {
  InstrumentTradingRules,
  InstrumentTradingRulesProvider,
} from "../../src/exchange/instrumentTradingRulesProvider.js";

export class FakeInstrumentTradingRulesProvider implements InstrumentTradingRulesProvider {
  // Recorded as "category:symbol", mirroring the production cache key, so
  // tests can assert both which symbol and which category a lookup used.
  readonly getRulesCalls: string[] = [];
  rulesBySymbol = new Map<string, InstrumentTradingRules>();
  defaultRules: InstrumentTradingRules = {
    minOrderQty: "0.001",
    qtyStep: "0.001",
    minNotionalValue: "5",
    tickSize: "0.5",
    minPrice: "0.5",
    maxPrice: "1999999.98",
  };
  failure: Error | undefined;

  async getRules(symbol: string, category: "linear" | "spot"): Promise<InstrumentTradingRules> {
    this.getRulesCalls.push(`${category}:${symbol}`);

    if (this.failure !== undefined) {
      throw this.failure;
    }

    return this.rulesBySymbol.get(symbol) ?? this.defaultRules;
  }
}
