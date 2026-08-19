import assert from "node:assert/strict";
import test from "node:test";

import {
  SURROGATE_TAKE_DISTANCE_RATIO,
  computeSurrogateTakePrice,
  reconcileNativePartialProtection,
} from "../../src/services/protection/nativeProtectionReconciliation.js";
import type { DesiredProtectionState } from "../../src/services/protection/nativeProtectionReconciliation.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";

const ENTRY_ORDER_LINK_ID = "abi-ep-entry-1";
const CATEGORY = "linear" as const;
const SYMBOL = "BTCUSDT";

function childRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: SYMBOL,
    orderLinkId: "",
    orderId: "order-1",
    parentOrderLinkId: ENTRY_ORDER_LINK_ID,
    stopOrderType: "PartialStopLoss",
    createType: "CreateByPartialStopLoss",
    orderStatus: "Untriggered",
    triggerPrice: "99000",
    qty: "0.001",
    leavesQty: "0.001",
    ...overrides,
  };
}

function realtimeList(rows: Record<string, unknown>[]): unknown {
  return { retCode: 0, result: { category: CATEGORY, list: rows } };
}

function historyList(rows: Record<string, unknown>[]): unknown {
  return { retCode: 0, result: { category: CATEGORY, list: rows } };
}

// Sets up an attributed pair whose realtime rows are the same mutable
// objects the fake returns on every getActiveOrders() call, and wraps
// amendOrder so a successful amend updates those same objects in place —
// letting a post-amend fresh read-back actually observe the applied
// change, the way the real exchange would, rather than the static fixture
// value it started with.
function attributedPair(bybit: FakeBybitAdapter, overrides: { stop?: Record<string, unknown>; take?: Record<string, unknown> } = {}): void {
  const stopRow = childRow({ orderId: "stop-1", stopOrderType: "PartialStopLoss", triggerPrice: "99000", qty: "0.004", ...overrides.stop });
  const takeRow = childRow({
    orderId: "take-1",
    stopOrderType: "PartialTakeProfit",
    createType: "CreateByPartialTakeProfit",
    triggerPrice: "103000",
    qty: "0.004",
    ...overrides.take,
  });
  bybit.activeOrdersResponse = realtimeList([stopRow, takeRow]);
  bybit.orderHistoryForSymbolResponse = historyList([]);

  const originalAmendOrder = bybit.amendOrder.bind(bybit);
  bybit.amendOrder = async (payload) => {
    const response = await originalAmendOrder(payload);
    const target = [stopRow, takeRow].find((row) => row.orderId === payload.orderId);
    if (target !== undefined && isAcknowledgedForTest(response)) {
      if (payload.triggerPrice !== undefined) {
        target.triggerPrice = payload.triggerPrice;
      }
      if (payload.qty !== undefined) {
        // qty on one leg pair-wide-synchronizes the sibling's qty
        // (confirmed spike fact, design.md Decision 6).
        stopRow.qty = payload.qty;
        takeRow.qty = payload.qty;
      }
    }
    return response;
  };
}

function isAcknowledgedForTest(response: unknown): boolean {
  if (typeof response !== "object" || response === null || !("retCode" in response)) {
    return false;
  }
  return (response as Record<string, unknown>).retCode === 0;
}

function desired(overrides: Partial<{ stopTriggerPrice: string; takeTriggerPrice: string; qty: string }> = {}): DesiredProtectionState {
  return {
    stop: { triggerPrice: overrides.stopTriggerPrice ?? "99000", qty: overrides.qty ?? "0.004" },
    take: { triggerPrice: overrides.takeTriggerPrice ?? "103000", qty: overrides.qty ?? "0.004" },
  };
}

async function reconcile(bybit: FakeBybitAdapter, desiredState: DesiredProtectionState) {
  return reconcileNativePartialProtection({
    bybit,
    category: CATEGORY,
    symbol: SYMBOL,
    entryOrderLinkId: ENTRY_ORDER_LINK_ID,
    desired: desiredState,
  });
}

// ---- computeSurrogateTakePrice (task 4.2) ----

test("computeSurrogateTakePrice is deterministic and idempotent across repeated calls with unchanged inputs", () => {
  const input = { plannedEntryPrice: "100000", side: "long" as const, tickSize: "0.5" };
  const first = computeSurrogateTakePrice(input);
  const second = computeSurrogateTakePrice(input);
  assert.equal(first, second);
});

test("SURROGATE_TAKE_DISTANCE_RATIO is 0.5, a named documented constant", () => {
  assert.equal(SURROGATE_TAKE_DISTANCE_RATIO, 0.5);
});

test("long produces a price strictly above plannedEntryPrice, short strictly below", () => {
  const longResult = computeSurrogateTakePrice({ plannedEntryPrice: "100000", side: "long", tickSize: "0.5" });
  assert.equal(longResult, "150000");

  const shortResult = computeSurrogateTakePrice({ plannedEntryPrice: "100000", side: "short", tickSize: "0.5" });
  assert.equal(shortResult, "50000");
});

test("result is tick-aligned per the provided tickSize", () => {
  const result = computeSurrogateTakePrice({ plannedEntryPrice: "100000.33", side: "long", tickSize: "0.5" });
  // 100000.33 * 1.5 = 150000.495 -> ceil to 0.5 tick -> 150000.5
  assert.equal(result, "150000.5");
});

test("an exponent-form plannedEntryPrice (transport-legal exact-decimal syntax) computes correctly, exact — not through binary float", () => {
  // 1e3 == 1000, a syntactically valid exact-decimal string per the same
  // grammar this transport already accepts (isExactDecimalText).
  const longResult = computeSurrogateTakePrice({ plannedEntryPrice: "1e3", side: "long", tickSize: "0.5" });
  assert.equal(longResult, "1500");

  const shortResult = computeSurrogateTakePrice({ plannedEntryPrice: "1e3", side: "short", tickSize: "0.5" });
  assert.equal(shortResult, "500");
});

test("long rounds away from reference (up), short rounds away from reference (down) — not accidentally symmetric", () => {
  // A value that lands exactly mid-tick for both directions must round up
  // for long and down for short — never the same rounding behavior.
  const longResult = computeSurrogateTakePrice({ plannedEntryPrice: "100000.01", side: "long", tickSize: "1" });
  const shortResult = computeSurrogateTakePrice({ plannedEntryPrice: "100000.01", side: "short", tickSize: "1" });
  // long: 100000.01 * 1.5 = 150000.015 -> ceil(tick 1) = 150001
  assert.equal(longResult, "150001");
  // short: 100000.01 * 0.5 = 50000.005 -> floor(tick 1) = 50000
  assert.equal(shortResult, "50000");
});

// ---- reconcileNativePartialProtection (tasks 9.1-9.9) ----

test("9.1 already-attributed pair matching desired exactly returns already_satisfied with zero amendOrder calls", async () => {
  const bybit = new FakeBybitAdapter();
  attributedPair(bybit);

  const result = await reconcile(bybit, desired());

  assert.deepEqual(result, { kind: "already_satisfied" });
  assert.equal(bybit.amendOrderCalls.length, 0);
});

test("9.2 only stop_price changed → exactly one amendOrder call on the STOP leg's orderId, carrying only the new triggerPrice", async () => {
  const bybit = new FakeBybitAdapter();
  attributedPair(bybit);

  const result = await reconcile(bybit, desired({ stopTriggerPrice: "98000" }));

  assert.deepEqual(result, { kind: "reconciled" });
  assert.equal(bybit.amendOrderCalls.length, 1);
  assert.deepEqual(bybit.amendOrderCalls[0], {
    category: CATEGORY,
    symbol: SYMBOL,
    orderId: "stop-1",
    triggerPrice: "98000",
  });
});

test("9.3 only qty changed → exactly one amendOrder call, deterministically on the STOP leg's orderId, carrying only the new qty", async () => {
  const bybit = new FakeBybitAdapter();
  attributedPair(bybit);

  const result = await reconcile(bybit, desired({ qty: "0.006" }));

  assert.deepEqual(result, { kind: "reconciled" });
  assert.equal(bybit.amendOrderCalls.length, 1);
  assert.deepEqual(bybit.amendOrderCalls[0], {
    category: CATEGORY,
    symbol: SYMBOL,
    orderId: "stop-1",
    qty: "0.006",
  });
});

test("9.4 both stop_price and take_price changed, qty unchanged → exactly two amendOrder calls, each carrying only its own new triggerPrice", async () => {
  const bybit = new FakeBybitAdapter();
  attributedPair(bybit);

  const result = await reconcile(bybit, desired({ stopTriggerPrice: "98000", takeTriggerPrice: "104000" }));

  assert.deepEqual(result, { kind: "reconciled" });
  assert.equal(bybit.amendOrderCalls.length, 2);
  assert.deepEqual(bybit.amendOrderCalls[0], {
    category: CATEGORY,
    symbol: SYMBOL,
    orderId: "stop-1",
    triggerPrice: "98000",
  });
  assert.deepEqual(bybit.amendOrderCalls[1], {
    category: CATEGORY,
    symbol: SYMBOL,
    orderId: "take-1",
    triggerPrice: "104000",
  });
});

test("9.4a qty and both triggerPrices change together → STOP carries triggerPrice+qty, TAKE carries only triggerPrice", async () => {
  const bybit = new FakeBybitAdapter();
  attributedPair(bybit);

  const result = await reconcile(
    bybit,
    desired({ stopTriggerPrice: "98000", takeTriggerPrice: "104000", qty: "0.006" }),
  );

  assert.deepEqual(result, { kind: "reconciled" });
  assert.equal(bybit.amendOrderCalls.length, 2);
  assert.deepEqual(bybit.amendOrderCalls[0], {
    category: CATEGORY,
    symbol: SYMBOL,
    orderId: "stop-1",
    triggerPrice: "98000",
    qty: "0.006",
  });
  assert.deepEqual(bybit.amendOrderCalls[1], {
    category: CATEGORY,
    symbol: SYMBOL,
    orderId: "take-1",
    triggerPrice: "104000",
  });
});

test("9.4b qty changed and only TAKE's triggerPrice also changed → STOP carries qty only (even though its own triggerPrice is unchanged), TAKE carries only its new triggerPrice", async () => {
  const bybit = new FakeBybitAdapter();
  attributedPair(bybit);

  const result = await reconcile(bybit, desired({ takeTriggerPrice: "104000", qty: "0.006" }));

  assert.deepEqual(result, { kind: "reconciled" });
  assert.equal(bybit.amendOrderCalls.length, 2);
  assert.deepEqual(bybit.amendOrderCalls[0], {
    category: CATEGORY,
    symbol: SYMBOL,
    orderId: "stop-1",
    qty: "0.006",
  });
  assert.deepEqual(bybit.amendOrderCalls[1], {
    category: CATEGORY,
    symbol: SYMBOL,
    orderId: "take-1",
    triggerPrice: "104000",
  });
});

test("9.5 take_price: null against an already-materialized real TAKE reconciles TAKE's triggerPrice toward the surrogate, same write-plan as any other take_price change", async () => {
  const bybit = new FakeBybitAdapter();
  attributedPair(bybit, { take: { triggerPrice: "103000" } });

  const result = await reconcile(bybit, desired({ takeTriggerPrice: "150000" }));

  assert.deepEqual(result, { kind: "reconciled" });
  assert.equal(bybit.amendOrderCalls.length, 1);
  assert.deepEqual(bybit.amendOrderCalls[0], {
    category: CATEGORY,
    symbol: SYMBOL,
    orderId: "take-1",
    triggerPrice: "150000",
  });
});

test("9.6 initial classification none → attribution_lost, zero amendOrder calls", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.activeOrdersResponse = realtimeList([]);
  bybit.orderHistoryForSymbolResponse = historyList([]);

  const result = await reconcile(bybit, desired());

  assert.deepEqual(result, { kind: "fail_closed", reason: "attribution_lost" });
  assert.equal(bybit.amendOrderCalls.length, 0);
});

test("9.6 initial classification ambiguous → ambiguous_attribution, zero amendOrder calls", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.activeOrdersResponse = realtimeList([childRow({ orderId: "stop-1", stopOrderType: "PartialStopLoss" })]);
  bybit.orderHistoryForSymbolResponse = historyList([]);

  const result = await reconcile(bybit, desired());

  assert.deepEqual(result, { kind: "fail_closed", reason: "ambiguous_attribution" });
  assert.equal(bybit.amendOrderCalls.length, 0);
});

test("9.7 a non-zero retCode amendOrder response fails the whole attempt amend_rejected; the first leg's already-applied amend is not rolled back", async () => {
  const bybit = new FakeBybitAdapter();
  attributedPair(bybit);
  bybit.amendOrderResponseByOrderId.set("take-1", { retCode: 10001, retMsg: "rejected" });

  const result = await reconcile(bybit, desired({ stopTriggerPrice: "98000", takeTriggerPrice: "104000" }));

  assert.deepEqual(result, { kind: "fail_closed", reason: "amend_rejected" });
  // Both calls were attempted (STOP succeeded, TAKE failed) — no rollback
  // call of any kind is made.
  assert.equal(bybit.amendOrderCalls.length, 2);
});

test("9.7 a thrown amendOrder call also fails the whole attempt amend_rejected", async () => {
  const bybit = new FakeBybitAdapter();
  attributedPair(bybit);
  bybit.amendOrderError = new Error("transport failure");

  const result = await reconcile(bybit, desired({ stopTriggerPrice: "98000" }));

  assert.deepEqual(result, { kind: "fail_closed", reason: "amend_rejected" });
});

test("9.8 post-amend read-back mismatch (triggerPrice/qty on either leg) → read_back_mismatch", async () => {
  const bybit = new FakeBybitAdapter();
  attributedPair(bybit);
  // The amend call succeeds, but the response the read-back sees never
  // reflects the intended new triggerPrice.
  const originalGetActiveOrders = bybit.getActiveOrders.bind(bybit);
  let callCount = 0;
  bybit.getActiveOrders = async (queryInput) => {
    callCount += 1;
    if (callCount >= 2) {
      // Stale — still reports the old triggerPrice after the amend.
      return realtimeList([
        childRow({ orderId: "stop-1", stopOrderType: "PartialStopLoss", triggerPrice: "99000", qty: "0.004" }),
        childRow({
          orderId: "take-1",
          stopOrderType: "PartialTakeProfit",
          createType: "CreateByPartialTakeProfit",
          triggerPrice: "103000",
          qty: "0.004",
        }),
      ]);
    }
    return originalGetActiveOrders(queryInput);
  };

  const result = await reconcile(bybit, desired({ stopTriggerPrice: "98000" }));

  assert.deepEqual(result, { kind: "fail_closed", reason: "read_back_mismatch" });
});

test("9.8 post-amend read-back still attributes both legs but the amended leg now independently reports a terminal orderStatus → amend_race", async () => {
  const bybit = new FakeBybitAdapter();
  attributedPair(bybit);
  const originalGetActiveOrders = bybit.getActiveOrders.bind(bybit);
  let callCount = 0;
  bybit.getActiveOrders = async (queryInput) => {
    callCount += 1;
    if (callCount >= 2) {
      // Still attributed on both legs, but the amended STOP leg's own
      // orderStatus transitioned to terminal (Deactivated) in the window
      // between step 1 and the amend, and its triggerPrice never reflects
      // the intended amend either — the amend raced that leg's own
      // lifecycle transition.
      return realtimeList([
        childRow({ orderId: "stop-1", stopOrderType: "PartialStopLoss", orderStatus: "Deactivated", triggerPrice: "99000", qty: "0.004" }),
        childRow({
          orderId: "take-1",
          stopOrderType: "PartialTakeProfit",
          createType: "CreateByPartialTakeProfit",
          triggerPrice: "103000",
          qty: "0.004",
        }),
      ]);
    }
    return originalGetActiveOrders(queryInput);
  };
  bybit.orderHistoryForSymbolResponse = historyList([]);

  const result = await reconcile(bybit, desired({ stopTriggerPrice: "98000" }));

  assert.deepEqual(result, { kind: "fail_closed", reason: "amend_race" });
});

test("9.8 post-amend read-back showing the pair no longer attributable at all → read_back_mismatch", async () => {
  const bybit = new FakeBybitAdapter();
  attributedPair(bybit);
  const originalGetActiveOrders = bybit.getActiveOrders.bind(bybit);
  let callCount = 0;
  bybit.getActiveOrders = async (queryInput) => {
    callCount += 1;
    if (callCount >= 2) {
      // Only the TAKE leg remains attributable after the amend — the STOP
      // leg vanished from both realtime and history.
      return realtimeList([
        childRow({
          orderId: "take-1",
          stopOrderType: "PartialTakeProfit",
          createType: "CreateByPartialTakeProfit",
          triggerPrice: "103000",
          qty: "0.004",
        }),
      ]);
    }
    return originalGetActiveOrders(queryInput);
  };
  bybit.orderHistoryForSymbolResponse = historyList([]);

  const result = await reconcile(bybit, desired({ stopTriggerPrice: "98000" }));

  assert.deepEqual(result, { kind: "fail_closed", reason: "read_back_mismatch" });
});

test("9.9 reconciling one cycle's own pair never touches another cycle's orderIds as amend candidates", async () => {
  const bybit = new FakeBybitAdapter();
  attributedPair(bybit);
  // Add a second, independent owner's own attributed pair on the same
  // physical scope after attributedPair() has already wired up the
  // amend-application wrapper for this cycle's own two rows.
  const existingResponse = bybit.activeOrdersResponse as { result: { category: string; list: unknown[] } };
  existingResponse.result.list.push(
    childRow({
      orderId: "other-stop-1",
      stopOrderType: "PartialStopLoss",
      parentOrderLinkId: "abi-ep-someone-else",
      triggerPrice: "97000",
      qty: "0.01",
    }),
    childRow({
      orderId: "other-take-1",
      stopOrderType: "PartialTakeProfit",
      createType: "CreateByPartialTakeProfit",
      parentOrderLinkId: "abi-ep-someone-else",
      triggerPrice: "105000",
      qty: "0.01",
    }),
  );

  const result = await reconcile(bybit, desired({ stopTriggerPrice: "98000" }));

  assert.deepEqual(result, { kind: "reconciled" });
  assert.equal(bybit.amendOrderCalls.length, 1);
  assert.equal(bybit.amendOrderCalls[0].orderId, "stop-1");
});

// ---- Finding #1: terminal attributed protection is never active coverage ----

test("initial Deactivated pair whose triggerPrice/qty exactly match desired MUST NOT return already_satisfied", async () => {
  const bybit = new FakeBybitAdapter();
  attributedPair(bybit, { stop: { orderStatus: "Deactivated" } });

  const result = await reconcile(bybit, desired());

  assert.notEqual(result.kind, "already_satisfied");
  assert.deepEqual(result, { kind: "fail_closed", reason: "amend_race" });
  // No create/cancel/replacement, and no amend either — matching values on
  // a terminal leg gives the write-plan nothing to change.
  assert.equal(bybit.amendOrderCalls.length, 0);
});

test("post-amend terminal pair whose triggerPrice/qty exactly match desired MUST NOT return reconciled", async () => {
  const bybit = new FakeBybitAdapter();
  attributedPair(bybit);
  const originalGetActiveOrders = bybit.getActiveOrders.bind(bybit);
  let callCount = 0;
  bybit.getActiveOrders = async (queryInput) => {
    callCount += 1;
    if (callCount >= 2) {
      // The amend itself applied the intended new triggerPrice, but the
      // amended STOP leg also independently transitioned to terminal in
      // the same window — values match desired exactly, but this is not
      // live coverage.
      return realtimeList([
        childRow({ orderId: "stop-1", stopOrderType: "PartialStopLoss", orderStatus: "Deactivated", triggerPrice: "98000", qty: "0.004" }),
        childRow({
          orderId: "take-1",
          stopOrderType: "PartialTakeProfit",
          createType: "CreateByPartialTakeProfit",
          triggerPrice: "103000",
          qty: "0.004",
        }),
      ]);
    }
    return originalGetActiveOrders(queryInput);
  };
  bybit.orderHistoryForSymbolResponse = historyList([]);

  const result = await reconcile(bybit, desired({ stopTriggerPrice: "98000" }));

  assert.notEqual(result.kind, "reconciled");
  assert.deepEqual(result, { kind: "fail_closed", reason: "amend_race" });
});
