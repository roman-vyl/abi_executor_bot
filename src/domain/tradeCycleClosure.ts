// The proven completion of one trade cycle as both Runtime-facing success
// objects carry it (abi-trade-cycle-closure-confirmation-v1 D6). Execution
// price and time are not part of V1.
export type TradeCycleClosureReason = "stop_loss" | "take_profit" | "runtime_signal";

export const TRADE_CYCLE_CLOSURE_REASONS: ReadonlySet<TradeCycleClosureReason> = new Set([
  "stop_loss",
  "take_profit",
  "runtime_signal",
]);

export type TradeCycleClosure = {
  strategy_instance_id: string;
  trade_cycle_id: string;
  reason: TradeCycleClosureReason;
  order_id: string;
  // Non-null only for runtime_signal: ABI's own close order.
  order_link_id: string | null;
  // Non-null only for stop_loss / take_profit: the entry's orderLinkId.
  parent_order_link_id: string | null;
};

export function isValidTradeCycleClosureFor(
  closure: TradeCycleClosure,
  strategyInstanceId: string,
  tradeCycleId: string,
): boolean {
  if (
    closure.strategy_instance_id !== strategyInstanceId ||
    closure.trade_cycle_id !== tradeCycleId ||
    !TRADE_CYCLE_CLOSURE_REASONS.has(closure.reason) ||
    !isNonEmpty(closure.order_id)
  ) {
    return false;
  }
  if (closure.reason === "runtime_signal") {
    return isNonEmpty(closure.order_link_id) && closure.parent_order_link_id === null;
  }
  return closure.order_link_id === null && isNonEmpty(closure.parent_order_link_id);
}

function isNonEmpty(value: string | null): boolean {
  return typeof value === "string" && value.length > 0;
}
