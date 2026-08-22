import assert from "node:assert/strict";
import test from "node:test";

import type { EntryPackageExecutionRecord } from "../../src/correlation/entryPackageExecutionRecord.js";
import { evaluateRecoveryConvergence } from "../../src/services/entryCycleRecovery/recoveryConvergencePolicy.js";

const NOW = "2026-08-22T00:00:00.000Z";

function record(overrides: Partial<EntryPackageExecutionRecord> = {}): EntryPackageExecutionRecord {
  return {
    strategy_instance_id: "instance-1",
    trade_cycle_id: "cycle-1",
    ticker: "BTCUSDT.P",
    exchange_symbol: "BTCUSDT",
    exchange_category: "linear",
    created_at: NOW,
    updated_at: NOW,
    desired_entry: {
      side: "long",
      source_plan_bar_open_time_ms: 1,
      planned_entry_price: "100000",
      initial_stop_price: "99000",
      initial_take_price: "103000",
      locked_exit_profile: "runner",
    },
    risk_multiplier: "1",
    calculated_quantity: "0.001",
    order_link_id: "link-1",
    order_id: "order-1",
    close_order_link_id: null,
    close_order_id: null,
    first_fill_at_ms: null,
    generation: 1,
    status: "unknown",
    early_execution_observation: null,
    binding_history: [],
    pending_action: null,
    current_binding_started_at: NOW,
    ...overrides,
  };
}

for (const status of ["absent", "terminal_unfilled", "terminal_closed"] as const) {
  test(`evaluateRecoveryConvergence never converges an already durably-closed record (${status})`, () => {
    const decision = evaluateRecoveryConvergence({ state: "position_open" }, record({ status }), NOW);
    assert.deepEqual(decision, { kind: "no_change" });
  });
}

test("entry_order_live/position_open: pending_action:cancel never converges", () => {
  for (const state of ["entry_order_live", "position_open"] as const) {
    const decision = evaluateRecoveryConvergence({ state }, record({ pending_action: "cancel" }), NOW);
    assert.deepEqual(decision, { kind: "no_change" });
  }
});

test("entry_order_live/position_open: legacy pending_action never converges", () => {
  for (const state of ["entry_order_live", "position_open"] as const) {
    const decision = evaluateRecoveryConvergence({ state }, record({ pending_action: "amend" }), NOW);
    assert.deepEqual(decision, { kind: "no_change" });
  }
});

test("entry_order_live/position_open: order_id:null never converges, even with pending_action:create", () => {
  for (const state of ["entry_order_live", "position_open"] as const) {
    const decision = evaluateRecoveryConvergence(
      { state },
      record({ pending_action: "create", order_id: null }),
      NOW,
    );
    assert.deepEqual(decision, { kind: "no_change" });
  }
});

test("entry_order_live/position_open: pending_action:create converges to applied and clears pending_action", () => {
  for (const state of ["entry_order_live", "position_open"] as const) {
    const decision = evaluateRecoveryConvergence({ state }, record({ pending_action: "create" }), NOW);
    assert.deepEqual(decision, {
      kind: "converge",
      patch: { status: "applied", updated_at: NOW, pending_action: null },
    });
  }
});

test("entry_order_live/position_open: already applied with no pending_action is a no-op", () => {
  for (const state of ["entry_order_live", "position_open"] as const) {
    const decision = evaluateRecoveryConvergence({ state }, record({ status: "applied", pending_action: null }), NOW);
    assert.deepEqual(decision, { kind: "no_change" });
  }
});

test("terminal_without_fill: converges to terminal_unfilled with an appended binding_history close entry", () => {
  const decision = evaluateRecoveryConvergence({ state: "terminal_without_fill" }, record(), NOW);
  assert.equal(decision.kind, "converge");
  if (decision.kind === "converge") {
    assert.equal(decision.patch.status, "terminal_unfilled");
    assert.equal(decision.patch.pending_action, null);
    assert.equal(decision.patch.binding_history?.length, 1);
    assert.equal(decision.patch.binding_history?.[0]?.end_reason, "exchange_terminal");
  }
});

test("terminal_without_fill: pending_action:cancel is left to its own dedicated path", () => {
  const decision = evaluateRecoveryConvergence(
    { state: "terminal_without_fill" },
    record({ pending_action: "cancel" }),
    NOW,
  );
  assert.deepEqual(decision, { kind: "no_change" });
});

test("terminal_after_fill: converges to terminal_closed with no binding_history append", () => {
  const decision = evaluateRecoveryConvergence({ state: "terminal_after_fill" }, record(), NOW);
  assert.deepEqual(decision, {
    kind: "converge",
    patch: { status: "terminal_closed", pending_action: null, updated_at: NOW },
  });
});

test("terminal_after_fill: any non-null pending_action is a no-op", () => {
  for (const pendingAction of ["create", "cancel", "amend", "cancel_and_create"] as const) {
    const decision = evaluateRecoveryConvergence(
      { state: "terminal_after_fill" },
      record({ pending_action: pendingAction }),
      NOW,
    );
    assert.deepEqual(decision, { kind: "no_change" });
  }
});

test("entry_order_not_found: converges to absent, reusing the same shape as the successful-CANCEL write", () => {
  const decision = evaluateRecoveryConvergence(
    { state: "entry_order_not_found" },
    record({ status: "pending_create", pending_action: "create" }),
    NOW,
  );
  assert.equal(decision.kind, "converge");
  if (decision.kind === "converge") {
    assert.equal(decision.patch.status, "absent");
    assert.equal(decision.patch.desired_entry, null);
    assert.equal(decision.patch.order_link_id, null);
    assert.equal(decision.patch.order_id, null);
    assert.equal(decision.patch.pending_action, null);
    assert.equal(decision.patch.current_binding_started_at, null);
    assert.equal(decision.patch.binding_history?.length, 1);
    assert.equal(decision.patch.binding_history?.[0]?.end_reason, "cancelled");
  }
});

test("entry_order_not_found: already absent is a no-op", () => {
  const decision = evaluateRecoveryConvergence({ state: "entry_order_not_found" }, record({ status: "absent" }), NOW);
  assert.deepEqual(decision, { kind: "no_change" });
});
