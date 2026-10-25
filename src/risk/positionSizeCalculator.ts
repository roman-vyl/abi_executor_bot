import {
  ceilRatioToStep,
  ceilToStep,
  compareDecimal,
  floorRatioToStep,
  maxDecimal,
  multiplyDecimal,
  subtractDecimal,
} from "../domain/exactDecimal.js";
import { decodeAccountMarginMode, decodeTotalWalletBalance } from "../exchange/accountSizingResponseDecoder.js";
import type { BybitAdapter } from "../exchange/bybitAdapter.js";
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

export type PositionSizeDeclineReason =
  | "insufficient_balance_for_minimum_quantity"
  | "quantity_above_exchange_maximum"
  | "invalid_stop_distance"
  | "margin_mode_not_supported";

// A quantity to submit, or an expected refusal decided before any exchange
// write. Read failures are not refusals: they are thrown.
export type PositionSizeResult =
  | { kind: "quantity"; quantity: string }
  | { kind: "declined"; reason: PositionSizeDeclineReason; message: string };

export interface PositionSizeCalculator {
  calculate(
    ticker: string,
    plannedEntryPrice: string,
    initialStopPrice: string,
    riskMultiplier: string,
    context: PositionSizeContext,
    side: "long" | "short",
  ): Promise<PositionSizeResult>;
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
  ): Promise<PositionSizeResult> {
    void ticker;
    void initialStopPrice;
    // V1 placeholder boundary: risk_multiplier is accepted and threaded
    // through the port but does not yet vary this formula.
    void riskMultiplier;

    const rules = await this.rulesProvider.getRules(context.resolvedSymbol, context.resolvedCategory);

    const qtyByMin = ceilToStep(rules.minOrderQty, rules.qtyStep);
    const qtyByNotional = ceilRatioToStep(rules.minNotionalValue, plannedEntryPrice, rules.qtyStep);

    return { kind: "quantity", quantity: maxDecimal(qtyByMin, qtyByNotional) };
  }
}

const SUPPORTED_MARGIN_MODES = new Set(["REGULAR_MARGIN", "PORTFOLIO_MARGIN"]);

// Risk sizing: quantity = (totalWalletBalance × riskMultiplier / 100) /
// |entry − stop|, rounded down to qtyStep, exact-decimal, net of fees and
// slippage. riskMultiplier is the risk percent itself (1 = 1 %). ABI adds
// no risk setting of its own and never raises the result to the exchange
// minimum: anything that does not fit the exchange limits is declined.
export class RiskPercentPositionSizeCalculator implements PositionSizeCalculator {
  private readonly rulesProvider: InstrumentTradingRulesProvider;
  private readonly bybit: BybitAdapter;

  constructor(rulesProvider: InstrumentTradingRulesProvider, bybit: BybitAdapter) {
    this.rulesProvider = rulesProvider;
    this.bybit = bybit;
  }

  async calculate(
    ticker: string,
    plannedEntryPrice: string,
    initialStopPrice: string,
    riskMultiplier: string,
    context: PositionSizeContext,
    side: "long" | "short",
  ): Promise<PositionSizeResult> {
    void ticker;

    // Stop below a long entry or above a short entry; checked before any read.
    const stopVsEntry = compareDecimal(initialStopPrice, plannedEntryPrice);
    if ((side === "long" && stopVsEntry >= 0) || (side === "short" && stopVsEntry <= 0)) {
      return declined(
        "invalid_stop_distance",
        `stop ${initialStopPrice} is not on the loss side of ${side} entry ${plannedEntryPrice}`,
      );
    }
    const distance =
      side === "long"
        ? subtractDecimal(plannedEntryPrice, initialStopPrice)
        : subtractDecimal(initialStopPrice, plannedEntryPrice);

    // Account-wide balance fields are not defined for isolated margin, so
    // ABI never switches to a per-coin balance in their place.
    const marginMode = decodeAccountMarginMode(await this.bybit.getAccountInfo());
    if (marginMode === null) {
      throw new Error("Bybit account-info response has no usable marginMode");
    }
    if (!SUPPORTED_MARGIN_MODES.has(marginMode)) {
      return declined("margin_mode_not_supported", `marginMode ${marginMode}`);
    }

    const walletBalance = decodeTotalWalletBalance(await this.bybit.getWalletBalance());
    if (walletBalance === null) {
      throw new Error("Bybit wallet-balance response has no usable totalWalletBalance");
    }
    if (compareDecimal(walletBalance, "0") <= 0) {
      return declined("insufficient_balance_for_minimum_quantity", `totalWalletBalance ${walletBalance}`);
    }

    const rules = await this.rulesProvider.getRules(context.resolvedSymbol, context.resolvedCategory);
    if (rules.maxMktOrderQty === null) {
      throw new Error(`Bybit instruments-info for ${context.resolvedSymbol} has no usable maxMktOrderQty`);
    }

    const quantity = floorRatioToStep(
      multiplyDecimal(walletBalance, riskMultiplier),
      multiplyDecimal(distance, "100"),
      rules.qtyStep,
    );
    const basis = `wallet ${walletBalance}, risk ${riskMultiplier}%, distance ${distance}`;

    if (compareDecimal(quantity, "0") <= 0 || compareDecimal(quantity, rules.minOrderQty) < 0) {
      return declined(
        "insufficient_balance_for_minimum_quantity",
        `quantity ${quantity} below minOrderQty ${rules.minOrderQty} (${basis})`,
      );
    }
    const notional = multiplyDecimal(quantity, plannedEntryPrice);
    if (compareDecimal(notional, rules.minNotionalValue) < 0) {
      return declined(
        "insufficient_balance_for_minimum_quantity",
        `order value ${notional} below minNotionalValue ${rules.minNotionalValue} (${basis})`,
      );
    }
    if (compareDecimal(quantity, rules.maxMktOrderQty) > 0) {
      return declined(
        "quantity_above_exchange_maximum",
        `quantity ${quantity} above maxMktOrderQty ${rules.maxMktOrderQty} (${basis})`,
      );
    }

    return { kind: "quantity", quantity };
  }
}

function declined(reason: PositionSizeDeclineReason, message: string): PositionSizeResult {
  return { kind: "declined", reason, message };
}
