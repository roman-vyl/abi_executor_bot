import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { KeyedMutex } from "../../src/concurrency/keyedMutex.js";
import { EntryPackageCorrelationRepository } from "../../src/correlation/entryPackageCorrelationRepository.js";
import type {
  EntryPackageExecutionRecord,
  EntryPackageExecutionStatus,
  StoredEntryPackagePendingAction,
} from "../../src/correlation/entryPackageExecutionRecord.js";
import { EntryCycleRecoveryResolutionService } from "../../src/services/entryCycleRecovery/entryCycleRecoveryResolutionService.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";

test("missing correlation record fails closed as unknown_trade_cycle_binding, never a recovery_state", async () => {
  await withService(async ({ service, bybit }) => {
    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, {
      statusCode: 422,
      body: { error: { code: "unknown_trade_cycle_binding", message: "no correlation record exists for the requested pair" } },
    });
    assert.equal(bybit.getOrderByLinkIdCalls.length, 0);
    assert.equal(bybit.getOpenPositionsCalls.length, 0);
  });
});

// A durably closed status is ABI's own previously confirmed fact — a
// positive durable record produced by a prior completed operation, not an
// inference from an empty exchange query. Recovery resolves directly from
// it, before ever requiring order_link_id or querying Bybit, so a lost
// EntryPackageAbsent/terminal HTTP response never leaves the pair
// unrecoverable. See isDurablyClosedEntryPackageStatus.
test("status: absent resolves terminal_without_fill directly from the durable record, zero Bybit queries", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ status: "absent", orderLinkId: null, pendingAction: null }));

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, {
      statusCode: 200,
      body: {
        recovery_state: "terminal_without_fill",
        applied_entry_package: null,
        first_fill_at_ms: null,
        average_entry_price: null,
      },
    });
    assert.equal(bybit.getOrderByLinkIdCalls.length, 0);
    assert.equal(bybit.getOrderHistoryCalls.length, 0);
    assert.equal(bybit.getOpenPositionsCalls.length, 0);
  });
});

test("status: terminal_unfilled resolves terminal_without_fill directly from the durable record, zero Bybit queries", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ status: "terminal_unfilled", orderLinkId: null, pendingAction: null }));

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, {
      statusCode: 200,
      body: {
        recovery_state: "terminal_without_fill",
        applied_entry_package: null,
        first_fill_at_ms: null,
        average_entry_price: null,
      },
    });
    assert.equal(bybit.getOrderByLinkIdCalls.length, 0);
    assert.equal(bybit.getOrderHistoryCalls.length, 0);
    assert.equal(bybit.getOpenPositionsCalls.length, 0);
  });
});

test("status: terminal_closed resolves terminal_after_fill directly from the durable record, zero Bybit queries", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ status: "terminal_closed", orderLinkId: null, pendingAction: null }));

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, {
      statusCode: 200,
      body: {
        recovery_state: "terminal_after_fill",
        applied_entry_package: null,
        first_fill_at_ms: null,
        average_entry_price: null,
      },
    });
    assert.equal(bybit.getOrderByLinkIdCalls.length, 0);
    assert.equal(bybit.getOrderHistoryCalls.length, 0);
    assert.equal(bybit.getOpenPositionsCalls.length, 0);
  });
});

// A null order_link_id on a status that is NOT one of the three durably
// closed statuses (e.g. a genuinely inconclusive "unknown") must still fail
// safe — the durable-status short-circuit above is deliberately narrow, not
// a broad "order_link_id === null means terminal" rule.
test("a null order_link_id on a non-durably-closed status still fails safe (500), never inferred terminal", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ status: "unknown", orderLinkId: null }));

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
    assert.equal(bybit.getOrderByLinkIdCalls.length, 0);
    assert.equal(bybit.getOpenPositionsCalls.length, 0);
  });
});

// --- entry_order_live: own evidence is the candidate, the aggregate can only veto (opposite-side) ---

test("a live, unfilled order with no open position resolves entry_order_live, including the applied entry package", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "New" })]);
    bybit.openPositionsResponse = flatPosition();

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.equal(result.statusCode, 200);
    const body = result.body as { recovery_state: string; applied_entry_package: unknown };
    assert.equal(body.recovery_state, "entry_order_live");
    assert.deepEqual(body.applied_entry_package, {
      applied_desired_entry: makeRecord().desired_entry,
      calculated_quantity: "0.001",
    });
    assert.equal((result.body as { first_fill_at_ms: unknown }).first_fill_at_ms, null);
    assert.equal((result.body as { average_entry_price: unknown }).average_entry_price, null);
  });
});

// The blocker this change fixes: a same-side sibling cycle sharing the same
// physical scope already has an open position, visible in the same
// aggregate query — this must never block or delay this cycle's own,
// independently and positively proven entry_order_live resolution.
test("a live, unfilled order resolves entry_order_live even when the aggregate shows a same-side sibling's own open position", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ side: "long" }));
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "New" })]);
    bybit.openPositionsResponse = openPosition({ side: "Buy", avgPrice: "100000", openTime: 111 });

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.equal(result.statusCode, 200);
    assert.equal((result.body as { recovery_state: string }).recovery_state, "entry_order_live");
  });
});

test("a live, unfilled order fails safe when the aggregate shows an open position on the opposite side (genuine invariant violation)", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ side: "long" }));
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "New" })]);
    bybit.openPositionsResponse = openPosition({ side: "Sell", avgPrice: "100000", openTime: 111 });

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

// The aggregate is a veto, not required proof: a failing/inconclusive
// aggregate query cannot positively confirm an opposite-side position, so it
// cannot veto anything — own evidence alone remains sufficient.
test("a live, unfilled order resolves entry_order_live even when the aggregate query itself fails", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "New" })]);
    bybit.openPositionsError = new Error("timeout");

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.equal(result.statusCode, 200);
    assert.equal((result.body as { recovery_state: string }).recovery_state, "entry_order_live");
  });
});

// --- terminal_without_fill: same shape as entry_order_live ---

test("a zero-fill terminal order confirmed flat resolves terminal_without_fill", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.orderByLinkIdResponse = orderList([]);
    bybit.orderHistoryResponse = orderList([{ orderStatus: "Cancelled", cumExecQty: "0" }]);
    bybit.openPositionsResponse = flatPosition();

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, {
      statusCode: 200,
      body: {
        recovery_state: "terminal_without_fill",
        applied_entry_package: null,
        first_fill_at_ms: null,
        average_entry_price: null,
      },
    });
  });
});

test("a zero-fill terminal order resolves terminal_without_fill even when the aggregate shows a same-side sibling's own open position", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ side: "long" }));
    bybit.orderByLinkIdResponse = orderList([]);
    bybit.orderHistoryResponse = orderList([{ orderStatus: "Cancelled", cumExecQty: "0" }]);
    bybit.openPositionsResponse = openPosition({ side: "Buy", avgPrice: "100000", openTime: 111 });

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, {
      statusCode: 200,
      body: {
        recovery_state: "terminal_without_fill",
        applied_entry_package: null,
        first_fill_at_ms: null,
        average_entry_price: null,
      },
    });
  });
});

test("a zero-fill terminal order fails safe when the aggregate shows an open position on the opposite side", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ side: "long" }));
    bybit.orderByLinkIdResponse = orderList([]);
    bybit.orderHistoryResponse = orderList([{ orderStatus: "Cancelled", cumExecQty: "0" }]);
    bybit.openPositionsResponse = openPosition({ side: "Sell", avgPrice: "100000", openTime: 111 });

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("a zero-fill terminal order resolves terminal_without_fill even when the aggregate query itself fails", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.orderByLinkIdResponse = orderList([]);
    bybit.orderHistoryResponse = orderList([{ orderStatus: "Cancelled", cumExecQty: "0" }]);
    bybit.openPositionsError = new Error("timeout");

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, {
      statusCode: 200,
      body: {
        recovery_state: "terminal_without_fill",
        applied_entry_package: null,
        first_fill_at_ms: null,
        average_entry_price: null,
      },
    });
  });
});

// --- position_open (no close attempted): own order response sources the facts, aggregate is existence-only veto ---

test("a PartiallyFilled order with no close attempted and an already-durable first_fill_at_ms resolves position_open, sourced from this cycle's own order response", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ firstFillAtMs: 555 }));
    bybit.orderByLinkIdResponse = orderList([
      liveOrder({ orderStatus: "PartiallyFilled", cumExecQty: "0.0005", avgPrice: "100000" }),
    ]);
    // Aggregate deliberately carries a DIFFERENT avgPrice/openTime than this
    // cycle's own order response — the response must reflect the own-order
    // value, never the aggregate's.
    bybit.openPositionsResponse = openPosition({ side: "Buy", avgPrice: "999999", openTime: 111 });

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.equal(result.statusCode, 200);
    const body = result.body as {
      recovery_state: string;
      applied_entry_package: unknown;
      first_fill_at_ms: number;
      average_entry_price: string;
    };
    assert.equal(body.recovery_state, "position_open");
    assert.ok(body.applied_entry_package);
    assert.equal(body.first_fill_at_ms, 555);
    assert.equal(body.average_entry_price, "100000");
    assert.equal(bybit.getExecutionListCalls.length, 0);
  });
});

test("a Filled order with no close attempted and no durable first_fill_at_ms yet captures it via execution list and durably saves it", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "Filled", cumExecQty: "0.001", avgPrice: "100500" })]);
    bybit.openPositionsResponse = openPosition({ side: "Buy", avgPrice: "100500", openTime: 222 });
    bybit.executionListResponse = executionList([1785000012345]);

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.equal(result.statusCode, 200);
    const body = result.body as { recovery_state: string; first_fill_at_ms: number; average_entry_price: string };
    assert.equal(body.recovery_state, "position_open");
    assert.equal(body.first_fill_at_ms, 1785000012345);
    assert.equal(body.average_entry_price, "100500");
    assert.equal(bybit.getExecutionListCalls.length, 1);

    const stored = repo.get("instance-1", "cycle-1");
    assert.equal(stored?.first_fill_at_ms, 1785000012345);

    // A second resolve() reuses the durable value with no further capture.
    const second = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });
    assert.equal((second.body as { first_fill_at_ms: number }).first_fill_at_ms, 1785000012345);
    assert.equal(bybit.getExecutionListCalls.length, 1);
  });
});

test("an unresolvable first-fill capture fails safe rather than resolving position_open with a fabricated value", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "Filled", cumExecQty: "0.001", avgPrice: "100500" })]);
    bybit.openPositionsResponse = openPosition({ side: "Buy", avgPrice: "100500", openTime: 222 });
    // Own evidence proves a fill, but the execution-list capture finds
    // nothing attributable — a contradiction, never proof of no fill.
    bybit.executionListResponse = executionList([]);

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("a fill-carrying order response with an empty average price fails safe rather than fabricating one", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "PartiallyFilled", cumExecQty: "0.0005" })]);
    bybit.openPositionsResponse = openPosition({ side: "Buy", avgPrice: "100000", openTime: 111 });

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

// A found position only counts as confirming this trade cycle's own fill
// when its side plausibly matches the record's declared desired_entry side
// (the same rule OpenPositionResolutionService already applies) — the
// opposite side is some other exposure on the same symbol, not evidence
// this binding filled, and must fail safe rather than resolve position_open.
test("a long record with an open Sell position fails safe: opposite-side exposure is contradictory, not position_open", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ side: "long" }));
    bybit.orderByLinkIdResponse = orderList([
      liveOrder({ orderStatus: "PartiallyFilled", cumExecQty: "0.0005", avgPrice: "100000" }),
    ]);
    bybit.openPositionsResponse = openPosition({ side: "Sell", avgPrice: "100000", openTime: 111 });

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("a short record with an open Buy position fails safe: opposite-side exposure is contradictory, not position_open", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ side: "short" }));
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "Filled", cumExecQty: "0.001", avgPrice: "100000" })]);
    bybit.openPositionsResponse = openPosition({ side: "Buy", avgPrice: "100000", openTime: 111 });

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("own fill with no close attempted fails safe when the aggregate cannot confirm any matching position (genuinely flat)", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.orderByLinkIdResponse = orderList([
      liveOrder({ orderStatus: "PartiallyFilled", cumExecQty: "0.0005", avgPrice: "100000" }),
    ]);
    bybit.openPositionsResponse = flatPosition();

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

// Aggregate sibling activity alone can never turn a cycle with zero own fill
// into position_open — the fill-carrying branch is the only branch that can
// ever return position_open, structurally, regardless of the aggregate.
test("a live, unfilled order never resolves position_open, even with a matching-side aggregate position", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ side: "long" }));
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "New" })]);
    bybit.openPositionsResponse = openPosition({ side: "Buy", avgPrice: "100000", openTime: 111 });

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.notEqual((result.body as { recovery_state?: string }).recovery_state, "position_open");
    assert.equal((result.body as { recovery_state: string }).recovery_state, "entry_order_live");
  });
});

// --- terminal_after_fill / position_open (close attempted): own close-order identity is authoritative, exact-qty-matched ---

test("a fill with the cycle's own close order confirming an exact quantity match resolves terminal_after_fill, with no aggregate consultation", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ closeOrderLinkId: "close-link-1" }));
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "Filled", cumExecQty: "0.001", avgPrice: "100000" })]);
    bybit.orderByLinkIdResponseByLinkId.set(
      "close-link-1",
      orderList([liveOrder({ orderStatus: "Filled", cumExecQty: "0.001" })]),
    );
    bybit.orderHistoryResponseByLinkId.set(
      "close-link-1",
      orderList([liveOrder({ orderStatus: "Filled", cumExecQty: "0.001" })]),
    );
    // A same-side sibling's own open position is still visible in the
    // aggregate — must never override this cycle's own two-order evidence.
    bybit.openPositionsResponse = openPosition({ side: "Buy", avgPrice: "999999", openTime: 999 });

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, {
      statusCode: 200,
      body: {
        recovery_state: "terminal_after_fill",
        applied_entry_package: null,
        first_fill_at_ms: null,
        average_entry_price: null,
      },
    });
  });
});

test("a fill with the cycle's own close order confirming zero fill (rejected) resolves position_open from the cycle's own entry-order evidence", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ closeOrderLinkId: "close-link-1", firstFillAtMs: 777 }));
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "Filled", cumExecQty: "0.001", avgPrice: "100000" })]);
    bybit.orderByLinkIdResponseByLinkId.set("close-link-1", orderList([]));
    bybit.orderHistoryResponseByLinkId.set(
      "close-link-1",
      orderList([liveOrder({ orderStatus: "Cancelled", cumExecQty: "0" })]),
    );
    bybit.openPositionsResponse = openPosition({ side: "Buy", avgPrice: "100000", openTime: 111 });

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.equal(result.statusCode, 200);
    const body = result.body as { recovery_state: string; first_fill_at_ms: number; average_entry_price: string };
    assert.equal(body.recovery_state, "position_open");
    assert.equal(body.first_fill_at_ms, 777);
    assert.equal(body.average_entry_price, "100000");
  });
});

test("a fill with the cycle's own close order confirming only a partial (non-matching) fill fails safe", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ closeOrderLinkId: "close-link-1" }));
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "Filled", cumExecQty: "0.001", avgPrice: "100000" })]);
    bybit.orderByLinkIdResponseByLinkId.set("close-link-1", orderList([]));
    bybit.orderHistoryResponseByLinkId.set(
      "close-link-1",
      orderList([liveOrder({ orderStatus: "Filled", qty: "0.0004", cumExecQty: "0.0004" })]),
    );
    bybit.openPositionsResponse = openPosition({ side: "Buy", avgPrice: "100000", openTime: 111 });

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("a fill with the cycle's own close order still live fails safe, regardless of aggregate state", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ closeOrderLinkId: "close-link-1" }));
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "Filled", cumExecQty: "0.001", avgPrice: "100000" })]);
    bybit.orderByLinkIdResponseByLinkId.set("close-link-1", orderList([liveOrder({ orderStatus: "New" })]));
    bybit.openPositionsResponse = flatPosition();

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("a fill with the cycle's own close order genuinely not found fails safe", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ closeOrderLinkId: "close-link-1" }));
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "Filled", cumExecQty: "0.001", avgPrice: "100000" })]);
    bybit.orderByLinkIdResponseByLinkId.set("close-link-1", orderList([]));
    bybit.orderHistoryResponseByLinkId.set("close-link-1", orderList([]));
    bybit.openPositionsResponse = flatPosition();

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("a live entry order combined with a durably-recorded close attempt fails safe as a structural contradiction, without querying the close order", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ closeOrderLinkId: "close-link-1" }));
    bybit.orderByLinkIdResponse = orderList([
      liveOrder({ orderStatus: "PartiallyFilled", cumExecQty: "0.0005", avgPrice: "100000" }),
    ]);
    bybit.openPositionsResponse = flatPosition();

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
    assert.equal(bybit.getOrderByLinkIdCalls.some((call) => call.orderLinkId === "close-link-1"), false);
  });
});

test("an unusable cumulativeFilledQty on the entry order's own fill signal fails safe before ever querying the close order", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ closeOrderLinkId: "close-link-1" }));
    // orderStatus Filled with an empty cumExecQty is the transient
    // Bybit-documented omission this guard exists for.
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "Filled", cumExecQty: "", avgPrice: "100000" })]);
    bybit.openPositionsResponse = flatPosition();

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
    assert.equal(bybit.getOrderByLinkIdCalls.some((call) => call.orderLinkId === "close-link-1"), false);
  });
});

// --- absence-of-evidence / query-failure regression (unchanged) ---

test("a fill found only via order-history (already left the realtime set), confirmed by its own matched close order, resolves terminal_after_fill without the applied entry package", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ closeOrderLinkId: "close-link-1" }));
    bybit.orderByLinkIdResponse = orderList([]);
    bybit.orderHistoryResponse = orderList([{ orderStatus: "Filled", cumExecQty: "0.001", avgPrice: "100000" }]);
    bybit.orderByLinkIdResponseByLinkId.set("close-link-1", orderList([]));
    bybit.orderHistoryResponseByLinkId.set(
      "close-link-1",
      orderList([liveOrder({ orderStatus: "Filled", cumExecQty: "0.001" })]),
    );
    bybit.openPositionsResponse = flatPosition();

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, {
      statusCode: 200,
      body: {
        recovery_state: "terminal_after_fill",
        applied_entry_package: null,
        first_fill_at_ms: null,
        average_entry_price: null,
      },
    });
  });
});

// Central regression test for the absence-of-evidence rule: a clean-but-empty
// result everywhere proves nothing about what happened, and must never be
// treated as terminal_without_fill.
test("a clean-but-empty result everywhere (no live order, no history match, no position) fails safe, never terminal_without_fill", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.orderByLinkIdResponse = orderList([]);
    bybit.orderHistoryResponse = orderList([]);
    bybit.openPositionsResponse = flatPosition();

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("a fill observed with a flat position but a still-live order fails safe (contradictory, not position_open or entry_order_live)", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.orderByLinkIdResponse = orderList([
      liveOrder({ orderStatus: "PartiallyFilled", cumExecQty: "0.0005", avgPrice: "100000" }),
    ]);
    bybit.openPositionsResponse = flatPosition();

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("a query failure never resolves any state", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.orderByLinkIdResponse = malformedResponse();
    bybit.orderHistoryResponse = malformedResponse();
    bybit.openPositionsError = new Error("timeout");

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("resolution never causes an exchange side effect, including when it resolves entry_order_live", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "New" })]);
    bybit.openPositionsResponse = flatPosition();

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.equal((result.body as { recovery_state: string }).recovery_state, "entry_order_live");
    assert.equal(bybit.createOrderCalls.length, 0);
    assert.equal(bybit.cancelOrderCalls.length, 0);
  });
});

// --- legacy pending_action guard (unchanged) ---

// The old in-place-amend write path durably wrote the record's new
// desired_entry (B) BEFORE sending the amend, reusing the SAME
// order_link_id the prior desired_entry (A) was already bound to. If that
// amend went ambiguous, a live order found under that identity may still
// physically be A — so a legacy pending_action:"amend" (or
// "cancel_and_create") binding must never report B as AppliedEntryPackage
// via entry_order_live or position_open, even though the order/position
// evidence would otherwise resolve one of those states cleanly.
test("a legacy amend-pending binding with a live order and no position fails safe instead of reporting entry_order_live/B", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ pendingAction: "amend" }));
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "New" })]);
    bybit.openPositionsResponse = flatPosition();

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("a legacy cancel_and_create-pending binding with a live order and no position fails safe instead of reporting entry_order_live/B", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ pendingAction: "cancel_and_create" }));
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "New" })]);
    bybit.openPositionsResponse = flatPosition();

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("a legacy amend-pending binding with a fill confirmed by a matching-side open position fails safe instead of reporting position_open/B", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ pendingAction: "amend" }));
    bybit.orderByLinkIdResponse = orderList([
      liveOrder({ orderStatus: "PartiallyFilled", cumExecQty: "0.0005", avgPrice: "100000" }),
    ]);
    bybit.openPositionsResponse = openPosition({ side: "Buy", avgPrice: "100000", openTime: 111 });

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

// Terminal states carry no AppliedEntryPackage, so the legacy-amend
// ambiguity does not apply to them — they still resolve normally.
test("a legacy amend-pending binding still resolves terminal_without_fill when positively proven", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ pendingAction: "amend" }));
    bybit.orderByLinkIdResponse = orderList([]);
    bybit.orderHistoryResponse = orderList([{ orderStatus: "Cancelled", cumExecQty: "0" }]);
    bybit.openPositionsResponse = flatPosition();

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, {
      statusCode: 200,
      body: {
        recovery_state: "terminal_without_fill",
        applied_entry_package: null,
        first_fill_at_ms: null,
        average_entry_price: null,
      },
    });
  });
});

test("a legacy amend-pending binding still resolves terminal_after_fill when positively proven via its own close order", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ pendingAction: "amend", closeOrderLinkId: "close-link-1" }));
    bybit.orderByLinkIdResponse = orderList([]);
    bybit.orderHistoryResponse = orderList([{ orderStatus: "Filled", cumExecQty: "0.001", avgPrice: "100000" }]);
    bybit.orderByLinkIdResponseByLinkId.set("close-link-1", orderList([]));
    bybit.orderHistoryResponseByLinkId.set(
      "close-link-1",
      orderList([liveOrder({ orderStatus: "Filled", cumExecQty: "0.001" })]),
    );
    bybit.openPositionsResponse = flatPosition();

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, {
      statusCode: 200,
      body: {
        recovery_state: "terminal_after_fill",
        applied_entry_package: null,
        first_fill_at_ms: null,
        average_entry_price: null,
      },
    });
  });
});

function orderList(items: unknown[]): unknown {
  return { retCode: 0, result: { list: items } };
}

// Structurally invalid: `list` present but not an array, so it can never
// be mistaken for a clean "not found" or a real found order.
function malformedResponse(): unknown {
  return { retCode: 0, result: { list: "not-an-array" } };
}

function liveOrder(
  overrides: Partial<{ orderStatus: string; qty: string; cumExecQty: string; avgPrice: string }> = {},
): Record<string, unknown> {
  return {
    orderStatus: "New",
    triggerPrice: "100000",
    qty: "0.001",
    stopLoss: "99000",
    takeProfit: "103000",
    cumExecQty: "0",
    ...overrides,
  };
}

function flatPosition(): unknown {
  return {
    retCode: 0,
    result: { category: "linear", list: [{ symbol: "BTCUSDT", side: "", size: "0", positionIdx: 0, avgPrice: "", openTime: 0 }] },
  };
}

function openPosition(input: { side: "Buy" | "Sell"; avgPrice: string; openTime: number }): unknown {
  return {
    retCode: 0,
    result: {
      category: "linear",
      list: [
        {
          symbol: "BTCUSDT",
          side: input.side,
          size: "0.001",
          positionIdx: 0,
          avgPrice: input.avgPrice,
          openTime: input.openTime,
        },
      ],
    },
  };
}

function executionList(execTimesMs: number[]): unknown {
  return {
    retCode: 0,
    result: {
      category: "linear",
      list: execTimesMs.map((execTimeMs) => ({
        symbol: "BTCUSDT",
        execType: "Trade",
        execTime: String(execTimeMs),
      })),
      nextPageCursor: "",
    },
  };
}

function makeRecord(
  overrides: Partial<{
    side: "long" | "short";
    pendingAction: StoredEntryPackagePendingAction | null;
    status: EntryPackageExecutionStatus;
    orderLinkId: string | null;
    closeOrderLinkId: string | null;
    firstFillAtMs: number | null;
  }> = {},
): EntryPackageExecutionRecord {
  return {
    strategy_instance_id: "instance-1",
    trade_cycle_id: "cycle-1",
    ticker: "BTCUSDT.P",
    exchange_symbol: "BTCUSDT",
    exchange_category: "linear",
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
    calculated_quantity: "0.001",
    order_link_id: overrides.orderLinkId === undefined ? "link-1" : overrides.orderLinkId,
    order_id: "order-1",
    close_order_link_id: overrides.closeOrderLinkId ?? null,
    close_order_id: null,
    first_fill_at_ms: overrides.firstFillAtMs ?? null,
    generation: 1,
    status: overrides.status ?? "unknown",
    early_execution_observation: null,
    binding_history: [],
    pending_action: overrides.pendingAction === undefined ? "cancel" : overrides.pendingAction,
    current_binding_started_at: "2026-01-01T00:00:00.000Z",
  };
}

type Ctx = {
  service: EntryCycleRecoveryResolutionService;
  bybit: FakeBybitAdapter;
  repo: EntryPackageCorrelationRepository;
};

async function withService(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "abi-entry-cycle-recovery-"));
  try {
    const bybit = new FakeBybitAdapter();
    const repo = new EntryPackageCorrelationRepository(join(dir, "correlation.jsonl"));
    const service = new EntryCycleRecoveryResolutionService({ correlationRepository: repo, bybit, mutex: new KeyedMutex() });

    await fn({ service, bybit, repo });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
