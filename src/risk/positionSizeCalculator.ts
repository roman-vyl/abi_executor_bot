import { ceilRatioToStep, ceilToStep, maxDecimal } from "../domain/exactDecimal.js";
import type { InstrumentTradingRulesProvider } from "../exchange/instrumentTradingRulesProvider.js";

export type PositionSizeContext = {
  // The already-resolved Bybit symbol trading rules are looked up for.
  // ticker (below) is the raw Runtime ticker, kept for port/provenance
  // parity — instrument-rules lookups always use the resolved symbol.
  resolvedSymbol: string;
  // The resolved (or, for an existing binding, stored) exchange instrument
  // identity's category — required so the trading-rules lookup queries the
  // correct Bybit category instead of a global default.
  resolvedCategory: "linear" | "spot";
};

export interface PositionSizeCalculator {
  calculate(
    ticker: string,
    plannedEntryPrice: string,
    initialStopPrice: string,
    riskMultiplier: string,
    context: PositionSizeContext,
  ): Promise<string>;
}

// V1 sizing: calculated_quantity = max(qty_by_min, qty_by_notional), both
// rounded up to qty_step, exact-decimal throughout. This is a genuinely
// minimum-executable quantity, not a hardcoded literal — but it is still not
// real risk-based sizing.
export class FixedMinimumPositionSizeCalculator implements PositionSizeCalculator {
  private readonly rulesProvider: InstrumentTradingRulesProvider;

  constructor(rulesProvider: InstrumentTradingRulesProvider) {
    this.rulesProvider = rulesProvider;
  }

  async calculate(
    ticker: string,
    plannedEntryPrice: string,
    initialStopPrice: string,
    riskMultiplier: string,
    context: PositionSizeContext,
  ): Promise<string> {
    void ticker;
    void initialStopPrice;
    // V1 placeholder boundary: risk_multiplier is accepted and threaded
    // through the port but does not yet vary this formula.
    void riskMultiplier;

    const rules = await this.rulesProvider.getRules(context.resolvedSymbol, context.resolvedCategory);

    const qtyByMin = ceilToStep(rules.minOrderQty, rules.qtyStep);
    const qtyByNotional = ceilRatioToStep(rules.minNotionalValue, plannedEntryPrice, rules.qtyStep);

    return maxDecimal(qtyByMin, qtyByNotional);
  }
}
