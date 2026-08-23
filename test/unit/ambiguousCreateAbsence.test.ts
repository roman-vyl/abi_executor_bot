import assert from "node:assert/strict";
import test from "node:test";

import type { EntryPackageExecutionRecord } from "../../src/correlation/entryPackageExecutionRecord.js";
import {
  BYBIT_TRUSTWORTHY_EVIDENCE_WINDOW_MS,
  ambiguousCreateAbsenceCandidate,
  completedObservationIsFresh,
  decodeBybitServerTimeMs,
} from "../../src/services/entryPackage/ambiguousCreateAbsence.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";

test("strict ambiguous-CREATE eligibility accepts only the unresolved own-create shape", () => {
  assert.deepEqual(ambiguousCreateAbsenceCandidate(record()), {
    bindingStartedAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
    desiredSide: "long",
  });

  for (const ineligible of [
    record({ status: "applied" }),
    record({ status: "pending_cancel" }),
    record({ status: "create_failed" }),
    record({ pending_action: "cancel" }),
    record({ pending_action: "amend" }),
    record({ order_link_id: "" }),
    record({ order_link_id: null }),
    record({ desired_entry: null }),
    record({ first_fill_at_ms: 1 }),
    record({ close_order_link_id: "close-1" }),
    record({ close_order_id: "close-order-1" }),
    record({ early_execution_observation: observation() }),
    record({ current_binding_started_at: "2026-01-01" }),
  ]) {
    assert.equal(ambiguousCreateAbsenceCandidate(ineligible), undefined);
  }
});

test("Bybit server-time decoder rejects malformed envelopes and timestamps", () => {
  assert.equal(decodeBybitServerTimeMs({ retCode: 0, result: { timeSecond: "1767225600" } }), 1767225600000);
  for (const malformed of [
    null,
    {},
    { retCode: 1, result: { timeSecond: "1767225600" } },
    { retCode: 0 },
    { retCode: 0, result: {} },
    { retCode: 0, result: { timeSecond: 1767225600 } },
    { retCode: 0, result: { timeSecond: "01" } },
    { retCode: 0, result: { timeSecond: "0" } },
    { retCode: 0, result: { timeSecond: "-1" } },
  ]) {
    assert.equal(decodeBybitServerTimeMs(malformed), undefined);
  }
});

test("freshness is strict below seven days and uses only validated Bybit time", async () => {
  const bybit = new FakeBybitAdapter();
  const startedAtMs = Date.parse("2026-01-01T00:00:00.000Z");

  bybit.serverTimeResponse = serverTime(startedAtMs + BYBIT_TRUSTWORTHY_EVIDENCE_WINDOW_MS - 1000);
  assert.equal(await completedObservationIsFresh({ bybit, bindingStartedAtMs: startedAtMs }), true);

  bybit.serverTimeResponse = serverTime(startedAtMs + BYBIT_TRUSTWORTHY_EVIDENCE_WINDOW_MS);
  assert.equal(await completedObservationIsFresh({ bybit, bindingStartedAtMs: startedAtMs }), false);

  bybit.serverTimeResponse = serverTime(startedAtMs - 1000);
  assert.equal(await completedObservationIsFresh({ bybit, bindingStartedAtMs: startedAtMs }), false);

  bybit.serverTimeResponse = { retCode: 0, result: { timeSecond: "bad" } };
  assert.equal(await completedObservationIsFresh({ bybit, bindingStartedAtMs: startedAtMs }), false);
});

function record(overrides: Partial<EntryPackageExecutionRecord> = {}): EntryPackageExecutionRecord {
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
      source_plan_bar_open_time_ms: 1,
      planned_entry_price: "100",
      initial_stop_price: "99",
      initial_take_price: "103",
      locked_exit_profile: "runner",
    },
    risk_multiplier: "1",
    calculated_quantity: "0.001",
    order_link_id: "entry-1",
    order_id: null,
    close_order_link_id: null,
    close_order_id: null,
    first_fill_at_ms: null,
    generation: 1,
    status: "unknown",
    early_execution_observation: null,
    binding_history: [],
    pending_action: "create",
    current_binding_started_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function observation() {
  return {
    order_status: "PartiallyFilled",
    cumulative_filled_qty: "0.001",
    remaining_qty: "0",
    observed_at: "2026-01-01T00:00:01.000Z",
  };
}

function serverTime(ms: number): unknown {
  return { retCode: 0, result: { timeSecond: String(ms / 1000) } };
}
