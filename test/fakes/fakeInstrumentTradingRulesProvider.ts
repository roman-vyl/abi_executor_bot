import type {
  InstrumentTradingRules,
  InstrumentTradingRulesProvider,
} from "../../src/exchange/instrumentTradingRulesProvider.js";

export class FakeInstrumentTradingRulesProvider implements InstrumentTradingRulesProvider {
  readonly getRulesCalls: string[] = [];
  rulesBySymbol = new Map<string, InstrumentTradingRules>();
  defaultRules: InstrumentTradingRules = {
    minOrderQty: "0.001",
    qtyStep: "0.001",
    minNotionalValue: "5",
  };
  failure: Error | undefined;

  async getRules(symbol: string): Promise<InstrumentTradingRules> {
    this.getRulesCalls.push(symbol);

    if (this.failure !== undefined) {
      throw this.failure;
    }

    return this.rulesBySymbol.get(symbol) ?? this.defaultRules;
  }
}
