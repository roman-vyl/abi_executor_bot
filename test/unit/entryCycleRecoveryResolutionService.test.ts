import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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

test("a PartiallyFilled order confirmed by an open position resolves position_open, regardless of the order still being live", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "PartiallyFilled", cumExecQty: "0.0005" })]);
    bybit.openPositionsResponse = openPosition({ side: "Buy", avgPrice: "100000", openTime: 111 });

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
    assert.equal(body.first_fill_at_ms, 111);
    assert.equal(body.average_entry_price, "100000");
  });
});

test("a Filled order confirmed by an open position resolves position_open", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "Filled", cumExecQty: "0.001" })]);
    bybit.openPositionsResponse = openPosition({ side: "Buy", avgPrice: "100500", openTime: 222 });

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.equal(result.statusCode, 200);
    assert.equal((result.body as { recovery_state: string }).recovery_state, "position_open");
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
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "PartiallyFilled", cumExecQty: "0.0005" })]);
    bybit.openPositionsResponse = openPosition({ side: "Sell", avgPrice: "100000", openTime: 111 });

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("a short record with an open Buy position fails safe: opposite-side exposure is contradictory, not position_open", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ side: "short" }));
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "Filled", cumExecQty: "0.001" })]);
    bybit.openPositionsResponse = openPosition({ side: "Buy", avgPrice: "100000", openTime: 111 });

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("a fill found only via order-history (already left the realtime set), confirmed flat, resolves terminal_after_fill without the applied entry package", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.orderByLinkIdResponse = orderList([]);
    bybit.orderHistoryResponse = orderList([{ orderStatus: "Filled", cumExecQty: "0.001" }]);
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

// Central regression test for the absence-of-evidence rule (design.md
// Decision 4): a clean-but-empty result everywhere proves nothing about
// what happened, and must never be treated as terminal_without_fill.
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

test("a fill observed on a still-live order but a flat position fails safe (contradictory, not position_open or entry_order_live)", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "PartiallyFilled", cumExecQty: "0.0005" })]);
    bybit.openPositionsResponse = flatPosition();

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("a zero-fill terminal order contradicted by an open position fails safe", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.orderByLinkIdResponse = orderList([]);
    bybit.orderHistoryResponse = orderList([{ orderStatus: "Cancelled", cumExecQty: "0" }]);
    bybit.openPositionsResponse = openPosition({ side: "Buy", avgPrice: "100000", openTime: 111 });

    const result = await service.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });

    assert.deepEqual(result, { statusCode: 500, body: { error: { code: "internal_error", message: "internal error" } } });
  });
});

test("a zero-fill terminal order with an inconclusive position query fails safe, not merely because it didn't contradict", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.orderByLinkIdResponse = orderList([]);
    bybit.orderHistoryResponse = orderList([{ orderStatus: "Cancelled", cumExecQty: "0" }]);
    bybit.openPositionsError = new Error("timeout");

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
    bybit.orderByLinkIdResponse = orderList([liveOrder({ orderStatus: "PartiallyFilled", cumExecQty: "0.0005" })]);
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

test("a legacy amend-pending binding still resolves terminal_after_fill when positively proven", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ pendingAction: "amend" }));
    bybit.orderByLinkIdResponse = orderList([]);
    bybit.orderHistoryResponse = orderList([{ orderStatus: "Filled", cumExecQty: "0.001" }]);
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
  overrides: Partial<{ orderStatus: string; cumExecQty: string }> = {},
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

function makeRecord(
  overrides: Partial<{
    side: "long" | "short";
    pendingAction: StoredEntryPackagePendingAction | null;
    status: EntryPackageExecutionStatus;
    orderLinkId: string | null;
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
    const service = new EntryCycleRecoveryResolutionService({ correlationRepository: repo, bybit });

    await fn({ service, bybit, repo });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
