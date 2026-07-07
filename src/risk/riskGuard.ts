import type { AbiConfig } from "../config/config.js";
import type { SignalIntent } from "../domain/signals.js";

export type RiskDecision =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: string;
    };

export function checkSignalRisk(intent: SignalIntent, config: AbiConfig): RiskDecision {
  const fixedSmokeQty = Number(config.fixedSmokeQty);

  if (!Number.isFinite(fixedSmokeQty) || fixedSmokeQty <= 0) {
    return { ok: false, error: "ABI_FIXED_SMOKE_QTY must be a positive number" };
  }

  const entryPrice = Number(intent.entry.triggerPrice);
  const stopLossPrice = Number(intent.stopLoss.triggerPrice);
  const takeProfitPrice = Number(intent.takeProfit.triggerPrice);

  if (intent.side === "long" && !(stopLossPrice < entryPrice && entryPrice < takeProfitPrice)) {
    return { ok: false, error: "long requires stop_loss < entry < take_profit" };
  }

  if (intent.side === "short" && !(takeProfitPrice < entryPrice && entryPrice < stopLossPrice)) {
    return { ok: false, error: "short requires take_profit < entry < stop_loss" };
  }

  return { ok: true };
}
