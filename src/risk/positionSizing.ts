import type { AbiConfig } from "../config/config.js";
import type { SignalIntent } from "../domain/signals.js";

export type PositionSize = {
  qty: string;
  reason: string;
};

export function calculatePositionSize(intent: SignalIntent, config: AbiConfig): PositionSize {
  void intent;

  return {
    qty: config.fixedSmokeQty,
    reason: "fixed_smoke_qty_from_ABI_FIXED_SMOKE_QTY",
  };
}
