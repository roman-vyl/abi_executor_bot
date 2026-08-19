import assert from "node:assert/strict";
import test from "node:test";

import type { EarlyExecutionObservation, EntryPackageExecutionRecord } from "../../src/correlation/entryPackageExecutionRecord.js";
import {
  resolveCurrentOwnFilledQty,
  resolveDesiredProtectionState,
} from "../../src/services/protection/protectionApplicationService.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";
import { FakeInstrumentTradingRulesProvider } from "../fakes/fakeInstrumentTradingRulesProvider.js";

function baseRecord(overrides: Partial<EntryPackageExecutionRecord> = {}): EntryPackageExecutionRecord {
  return {
    strategy_instance_id: "instance-1",
    trade_cycle_id: "cycle-1",
    ticker: "BTCUSDT.P",
    exchange_symbol: "BTCUSDT",
    exchange_category: "linear",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    desired_entry: {
      side: "long",
      source_plan_bar_open_time_ms: 1785000000000,
      planned_entry_price: "100000",
      initial_stop_price: "99000",
      initial_take_price: "103000",
      locked_exit_profile: "runner",
    },
    risk_multiplier: "1",
    calculated_quantity: "10",
    order_link_id: "link-1",
    order_id: "order-1",
    close_order_link_id: null,
    close_order_id: null,
    first_fill_at_ms: null,
    generation: 1,
    status: "applied",
    early_execution_observation: null,
    binding_history: [],
    pending_action: null,
    current_binding_started_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function finalObservation(overrides: Partial<EarlyExecutionObservation> = {}): EarlyExecutionObservation {
  return {
    order_status: "Filled",
    cumulative_filled_qty: "10",
    remaining_qty: "0",
    avg_execution_price: "100000",
    observed_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function orderRealtimeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: "BTCUSDT",
    orderStatus: "PartiallyFilled",
    qty: "10",
    cumExecQty: "4",
    avgPrice: "100000",
    ...overrides,
  };
}

// ---- resolveCurrentOwnFilledQty (tasks 5.1, 5.3, 5.4) ----

test("a present and final early_execution_observation is reused directly without any confirmEntryPackage() call", async () => {
  const bybit = new FakeBybitAdapter();
  const record = baseRecord({ early_execution_observation: finalObservation({ cumulative_filled_qty: "10" }) });

  const result = await resolveCurrentOwnFilledQty({ record, bybit });

  assert.deepEqual(result, { ok: true, qty: "10" });
  assert.equal(bybit.getOrderByLinkIdCalls.length, 0);
  assert.equal(bybit.getOrderHistoryCalls.length, 0);
});

test("5.3 an absent early_execution_observation issues a fresh confirmEntryPackage() call; a live partial fill is not blocked and not an error", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = { retCode: 0, result: { category: "linear", list: [orderRealtimeRow({ cumExecQty: "4" })] } };
  const record = baseRecord({ early_execution_observation: null });

  const result = await resolveCurrentOwnFilledQty({ record, bybit });

  assert.deepEqual(result, { ok: true, qty: "4" });
});

test("5.3 a later reconciliation attempt observing a larger cumulative_filled_qty resolves the new, larger value — the entry order's own remainder is never cancelled or amended", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = { retCode: 0, result: { category: "linear", list: [orderRealtimeRow({ cumExecQty: "7", orderStatus: "PartiallyFilled" })] } };
  const record = baseRecord({ early_execution_observation: null });

  const result = await resolveCurrentOwnFilledQty({ record, bybit });

  assert.deepEqual(result, { ok: true, qty: "7" });
  assert.equal(bybit.cancelOrderCalls.length, 0);
  assert.equal(bybit.amendOrderCalls.length, 0);
});

test("5.4 a non-final early_execution_observation also issues a fresh confirmEntryPackage() call, accepting a full_fill outcome as authoritative", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = { retCode: 0, result: { category: "linear", list: [orderRealtimeRow({ orderStatus: "Filled", cumExecQty: "10" })] } };
  const record = baseRecord({
    early_execution_observation: { order_status: "PartiallyFilled", cumulative_filled_qty: "4", remaining_qty: "6", observed_at: "2026-01-01T00:00:00.000Z" },
  });

  const result = await resolveCurrentOwnFilledQty({ record, bybit });

  assert.deepEqual(result, { ok: true, qty: "10" });
  assert.ok(bybit.getOrderByLinkIdCalls.length > 0, "expected a fresh confirmEntryPackage() query since the stored observation was not final");
});

test("5.4 terminal_without_fill fails closed with no_authoritative_qty, never falling back to \"0\"", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = { retCode: 0, result: { category: "linear", list: [] } };
  bybit.orderHistoryResponse = { retCode: 0, result: { category: "linear", list: [orderRealtimeRow({ orderStatus: "Cancelled", cumExecQty: "0" })] } };
  const record = baseRecord({ early_execution_observation: null });

  const result = await resolveCurrentOwnFilledQty({ record, bybit });

  assert.deepEqual(result, { ok: false, reason: "no_authoritative_qty" });
});

test("5.4 not_found fails closed with no_authoritative_qty", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = { retCode: 0, result: { category: "linear", list: [] } };
  bybit.orderHistoryResponse = { retCode: 0, result: { category: "linear", list: [] } };
  const record = baseRecord({ early_execution_observation: null });

  const result = await resolveCurrentOwnFilledQty({ record, bybit });

  assert.deepEqual(result, { ok: false, reason: "no_authoritative_qty" });
});

test("5.4 ambiguous (a query failure) fails closed with no_authoritative_qty", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.getOrderByLinkId = async () => {
    throw new Error("transport failure");
  };
  bybit.orderHistoryResponse = { retCode: 0, result: { category: "linear", list: [] } };
  const record = baseRecord({ early_execution_observation: null });

  const result = await resolveCurrentOwnFilledQty({ record, bybit });

  assert.deepEqual(result, { ok: false, reason: "no_authoritative_qty" });
});

test("5.4 pending_confirmed fails closed with no_authoritative_qty", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = { retCode: 0, result: { category: "linear", list: [orderRealtimeRow({ orderStatus: "New", qty: "10", cumExecQty: "0" })] } };
  const record = baseRecord({ early_execution_observation: null, calculated_quantity: "10" });

  const result = await resolveCurrentOwnFilledQty({ record, bybit });

  assert.deepEqual(result, { ok: false, reason: "no_authoritative_qty" });
});

test("5.4 diverges deliberately from OpenPositionResolutionService.resolveOwnFillFacts()'s own zero-fill-is-valid handling for a terminal_without_fill input", async () => {
  // OpenPositionResolutionService.resolveOwnFillFacts() treats
  // terminal_without_fill as a valid cumulativeFilledQty: "0" answer — this
  // function must not: "what quantity should protection now cover" has no
  // actionable zero answer, unlike "does a position exist".
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = { retCode: 0, result: { category: "linear", list: [] } };
  bybit.orderHistoryResponse = { retCode: 0, result: { category: "linear", list: [orderRealtimeRow({ orderStatus: "Rejected", cumExecQty: "0" })] } };
  const record = baseRecord({ early_execution_observation: null });

  const result = await resolveCurrentOwnFilledQty({ record, bybit });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "no_authoritative_qty");
  }
});

// ---- resolveDesiredProtectionState (task 5.2, 5.4) ----

test("a non-null take_price passes through unchanged, and both legs' qty are always equal", async () => {
  const bybit = new FakeBybitAdapter();
  const record = baseRecord({ early_execution_observation: finalObservation({ cumulative_filled_qty: "6" }) });
  const tradingRules = new FakeInstrumentTradingRulesProvider();

  const result = await resolveDesiredProtectionState({
    command: { strategyInstanceId: "instance-1", tradeCycleId: "cycle-1", stopPrice: "98000", takePrice: "104000" },
    record,
    bybit,
    tradingRules,
  });

  assert.deepEqual(result, {
    ok: true,
    desired: {
      stop: { triggerPrice: "98000", qty: "6" },
      take: { triggerPrice: "104000", qty: "6" },
    },
  });
});

test("take_price: null invokes surrogate computation using this cycle's own planned_entry_price, side, and instrument bounds", async () => {
  const bybit = new FakeBybitAdapter();
  const record = baseRecord({ early_execution_observation: finalObservation({ cumulative_filled_qty: "6" }) });
  const tradingRules = new FakeInstrumentTradingRulesProvider();
  tradingRules.defaultRules = { minOrderQty: "0.001", qtyStep: "0.001", minNotionalValue: "5", tickSize: "0.5", minPrice: "0.5", maxPrice: "1999999.98" };

  const result = await resolveDesiredProtectionState({
    command: { strategyInstanceId: "instance-1", tradeCycleId: "cycle-1", stopPrice: "98000", takePrice: null },
    record,
    bybit,
    tradingRules,
  });

  assert.ok(result.ok);
  if (result.ok) {
    // planned_entry_price 100000, long side, ratio 0.5 -> 150000
    assert.equal(result.desired.take.triggerPrice, "150000");
    assert.equal(result.desired.stop.qty, result.desired.take.qty);
  }
});

test("a fail-closed qty resolution propagates through resolveDesiredProtectionState without computing a surrogate or reading instrument rules", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = { retCode: 0, result: { category: "linear", list: [] } };
  bybit.orderHistoryResponse = { retCode: 0, result: { category: "linear", list: [] } };
  const record = baseRecord({ early_execution_observation: null });
  const tradingRules = new FakeInstrumentTradingRulesProvider();

  const result = await resolveDesiredProtectionState({
    command: { strategyInstanceId: "instance-1", tradeCycleId: "cycle-1", stopPrice: "98000", takePrice: null },
    record,
    bybit,
    tradingRules,
  });

  assert.deepEqual(result, { ok: false, reason: "no_authoritative_qty" });
  assert.equal(tradingRules.getRulesCalls.length, 0);
});
