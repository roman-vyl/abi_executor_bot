import type { EntryPackageExecutionRecord, EntryPackageExecutionStatus, EarlyExecutionObservation } from "../../src/correlation/entryPackageExecutionRecord.js";
import type { StoredFact, StoredLink } from "../../src/exchangeFacts/exchangeFactsStore.js";
import type { FirstFillFactsReader } from "../../src/services/firstFill/verifiedFirstFill.js";
export function firstFillRecord(
  overrides: Partial<{
    status: EntryPackageExecutionStatus;
    exchangeSymbol: string;
    exchangeCategory: "linear" | "spot";
    side: "long" | "short";
    calculatedQuantity: string | null;
    orderLinkId: string | null;
    earlyExecutionObservation: EarlyExecutionObservation | null;
    firstFillAtMs: number | null;
  }> = {},
): EntryPackageExecutionRecord {
  return {
    strategy_instance_id: "instance-1",
    trade_cycle_id: "cycle-1",
    ticker: "BTCUSDT.P",
    exchange_symbol: overrides.exchangeSymbol ?? "BTCUSDT",
    exchange_category: overrides.exchangeCategory ?? "linear",
    position_binding_mode: "one_way",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    desired_entry: {
      side: overrides.side ?? "long",
      source_plan_bar_open_time_ms: 1785000000000,
      planned_entry_price: "100000",
      initial_stop_price: "99000",
      initial_take_price: "103000",
      locked_exit_profile: "runner",
    },
    risk_multiplier: "1",
    calculated_quantity: overrides.calculatedQuantity ?? "0.001",
    order_link_id: overrides.orderLinkId ?? "link-1",
    order_id: "order-1",
    close_order_link_id: null,
    close_order_id: null,
    closure_reason: null,
    closure_order_id: null,
    closure_order_link_id: null,
    closure_parent_order_link_id: null,
    first_fill_at_ms: overrides.firstFillAtMs ?? null,
    generation: 1,
    status: overrides.status ?? "applied",
    early_execution_observation: overrides.earlyExecutionObservation ?? null,
    binding_history: [],
    pending_action: null,
    current_binding_started_at: "2026-01-01T00:00:00.000Z",
  };
}
export function executionFact(qty = "0.001", time = 1000, id = "exec-1", record = firstFillRecord()): StoredFact {
  const raw = { category: record.exchange_category, symbol: record.exchange_symbol, orderId: record.order_id,
    orderLinkId: record.order_link_id, execId: id, execTime: String(time), execType: "Trade", execQty: qty,
    side: record.desired_entry?.side === "short" ? "Sell" : "Buy", positionIdx: 0 };
  return { eventSeq: 1, kind: "execution", source: "ws", sourceEndpoint: "ws:execution", symbol: raw.symbol,
    orderId: raw.orderId, orderLinkId: raw.orderLinkId, parentOrderLinkId: null, execId: id, execType: "Trade",
    orderStatus: null, exchangeTimeMs: time, receivedAtMs: time + 100, dedupKey: id, rawJson: JSON.stringify(raw) };
}
export function factsReader(record = firstFillRecord(), facts = [executionFact()]): FirstFillFactsReader & { reads: number; link: StoredLink } {
  return { category: record.exchange_category, reads: 0, link: { linkSeq: 1, orderId: record.order_id!, orderLinkId: record.order_link_id,
    strategyInstanceId: record.strategy_instance_id, tradeCycleId: record.trade_cycle_id, generation: record.generation,
    role: "entry", parentOrderLinkId: null, evidence: "own_order_link_id_lookup", establishedAtMs: 1 },
    readLinkForOrder() { this.reads++; return this.link; },
    readFactsForOrder() { this.reads++; return facts; } };
}
