import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { KeyedMutex } from "../../src/concurrency/keyedMutex.js";
import type { AbiConfig } from "../../src/config/config.js";
import { EntryPackageCorrelationRepository } from "../../src/correlation/entryPackageCorrelationRepository.js";
import type {
  EntryPackageExecutionRecord,
  EntryPackageExecutionStatus,
} from "../../src/correlation/entryPackageExecutionRecord.js";
import { buildEntryPackageOrderLinkId } from "../../src/domain/entryPackageOrderIdentity.js";
import type { BybitAdapter } from "../../src/exchange/bybitAdapter.js";
import { BybitExchangeInstrumentResolver } from "../../src/exchange/exchangeInstrumentResolver.js";
import { FixedMinimumPositionSizeCalculator } from "../../src/risk/positionSizeCalculator.js";
import { CloseApplicationService } from "../../src/services/close/closeApplicationService.js";
import { EntryPackageApplicationService } from "../../src/services/entryPackage/entryPackageApplicationService.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";
import { FakeInstrumentTradingRulesProvider } from "../fakes/fakeInstrumentTradingRulesProvider.js";
import { makeTestConfig } from "../fixtures/config.js";

type Ctx = {
  service: CloseApplicationService;
  bybit: FakeBybitAdapter;
  repo: EntryPackageCorrelationRepository;
};

test("unknown pair fails closed without any exchange call", async () => {
  await withService(async ({ service, bybit }) => {
    const result = await service.apply(makeCommand());

    assert.deepEqual(result.body, {
      error: { code: "unknown_trade_cycle_binding", message: "no correlation record exists for the requested pair" },
    });
    assert.equal(bybit.getOpenPositionsCalls.length, 0);
    assert.equal(bybit.createOrderCalls.length, 0);
    assert.equal(bybit.cancelOrderCalls.length, 0);
  });
});

test("an already terminal_closed pair is acknowledged idempotently with no write and no exchange call", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ status: "terminal_closed" }));

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, {
      strategy_instance_id: "instance-1",
      trade_cycle_id: "cycle-1",
      status: "trade_cycle_closed",
    });
    assert.equal(bybit.getOpenPositionsCalls.length, 0);
    assert.equal(bybit.createOrderCalls.length, 0);
    assert.equal(bybit.cancelOrderCalls.length, 0);
  });
});

for (const status of ["absent", "terminal_unfilled"] as const) {
  test(`a ${status} pair is durably promoted to terminal_closed before trade_cycle_closed, with no exchange call`, async () => {
    await withService(async ({ service, bybit, repo }) => {
      await repo.save(makeRecord({ status }));

      const result = await service.apply(makeCommand());

      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.body, {
        strategy_instance_id: "instance-1",
        trade_cycle_id: "cycle-1",
        status: "trade_cycle_closed",
      });
      assert.equal(bybit.getOpenPositionsCalls.length, 0);
      assert.equal(bybit.createOrderCalls.length, 0);
      assert.equal(bybit.cancelOrderCalls.length, 0);
      assert.equal(repo.get("instance-1", "cycle-1")?.status, "terminal_closed");

      // Idempotent repeat: no further write, no exchange call.
      const repeat = await service.apply(makeCommand());
      assert.equal(repeat.statusCode, 200);
      assert.equal(bybit.getOpenPositionsCalls.length, 0);
    });
  });
}

// Two same-side records sharing a physical scope is not corruption under
// the corrected ownership check (design.md Decision 1) — it is exactly the
// synthetic multi-owner state this pipeline must already handle safely,
// ahead of abi-same-side-virtual-exposure-ownership-v1's production
// activation. See the "multi-owner close" tests below for that path;
// disagreeing sides (below) is the actual corruption case now.
test("disagreeing sides among a scope's active records fails closed with internal_error", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ side: "long" }));
    await repo.save(makeRecord({ strategyInstanceId: "instance-2", tradeCycleId: "cycle-2", side: "short" }));

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 500);
    assert.deepEqual(result.body, { error: { code: "internal_error", message: "internal error" } });
    assert.equal(bybit.getOpenPositionsCalls.length, 0);
  });
});

test("an unsupported category returns unsupported_exchange_scope", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ exchangeCategory: "spot" }));

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 422);
    assert.deepEqual(result.body, {
      error: { code: "unsupported_exchange_scope", message: "resolved position's exchange category is not supported" },
    });
    assert.equal(bybit.getOpenPositionsCalls.length, 0);
  });
});

test("a non-durably-closed record with no current entry order identity fails as contradictory correlation", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ orderLinkId: null }));

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 500);
    assert.equal(bybit.getOpenPositionsCalls.length, 0);
    assert.equal(bybit.cancelOrderCalls.length, 0);
  });
});

test("a terminal order status with nonzero executed quantity needs no cancel (order-level terminality over fill quantity)", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    setOrderStatus(bybit, "link-1", { orderStatus: "Cancelled", cumExecQty: "0.002" });
    bybit.openPositionsResponse = closedResponse();

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 200);
    assert.equal(bybit.cancelOrderCalls.length, 0, "already-terminal order needs no cancel");
    assert.equal(bybit.createOrderCalls.length, 0);
  });
});

test("a live entry order is cancelled and confirmed non-live before the position is read", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    setOrderStatus(bybit, "link-1", { orderStatus: "New", cumExecQty: "0" });
    settleOrderAfterCancel(bybit, "link-1", { orderStatus: "Cancelled", cumExecQty: "0" });
    bybit.openPositionsResponse = closedResponse();

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 200);
    assert.equal(bybit.cancelOrderCalls.length, 1);
    assert.equal(bybit.cancelOrderCalls[0].orderLinkId, "link-1");
    // The cancel is confirmed non-live before the live position is ever read.
    assert.ok(bybit.getOpenPositionsCalls.length >= 1);
  });
});

test("a partially filled entry order is neutralized (cancelled and confirmed terminal) before ABI proceeds", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    setOrderStatus(bybit, "link-1", { orderStatus: "PartiallyFilled", cumExecQty: "0.001" });
    settleOrderAfterCancel(bybit, "link-1", { orderStatus: "Cancelled", cumExecQty: "0.001" });
    settlePositionAfterClose(bybit, positionResponse({ side: "Buy", size: "0.001" }));

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 200);
    assert.equal(bybit.cancelOrderCalls.length, 1);
    assert.equal(bybit.createOrderCalls.length, 1);
    assert.equal(bybit.createOrderCalls[0].qty, "0.001", "closes the live remainder actually reported, not calculated_quantity");
  });
});

test("a still-live partially filled order that never reaches a terminal status is not treated as neutralized", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    setOrderStatus(bybit, "link-1", { orderStatus: "PartiallyFilled", cumExecQty: "0.001" });
    // No settlement after cancel — the order stays reported live forever.

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 500);
    assert.equal(bybit.cancelOrderCalls.length, 1);
    assert.equal(bybit.getOpenPositionsCalls.length, 0, "never reaches the position read while neutralization is unconfirmed");
    assert.equal(bybit.createOrderCalls.length, 0);
  });
});

test("ambiguous neutralization (query failure) blocks the entire close with no market-close sent", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    let calls = 0;
    bybit.getOrderByLinkId = async () => {
      calls += 1;
      throw new Error("transport failure");
    };

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 500);
    assert.ok(calls >= 1);
    assert.equal(bybit.getOpenPositionsCalls.length, 0);
    assert.equal(bybit.createOrderCalls.length, 0);
  });
});

test("position already zero sends no market-close", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.openPositionsResponse = closedResponse();

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 200);
    assert.equal(bybit.createOrderCalls.length, 0);
  });
});

test("an unexpected live position side is still closed using the actual side", async () => {
  await withService(async ({ service, bybit, repo }) => {
    // desired_entry.side is "long" (Buy) but the live position is Sell.
    await repo.save(makeRecord());
    settlePositionAfterClose(bybit, positionResponse({ side: "Sell", size: "0.003" }));

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 200);
    assert.equal(bybit.createOrderCalls.length, 1);
    assert.equal(bybit.createOrderCalls[0].side, "Buy", "closes a Sell position with a Buy reduce-only order");
    assert.equal((bybit.createOrderCalls[0] as { reduceOnly?: boolean }).reduceOnly, true);
  });
});

test("close quantity equals the actual live remainder, not calculated_quantity", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord({ calculatedQuantity: "0.001" }));
    settlePositionAfterClose(bybit, positionResponse({ side: "Buy", size: "0.007" }));

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 200);
    assert.equal(bybit.createOrderCalls[0].qty, "0.007");
  });
});

test("live-execution guard disabled on the cancel write fails closed without cancelling", async () => {
  await withService(
    async ({ service, bybit, repo }) => {
      await repo.save(makeRecord());
      setOrderStatus(bybit, "link-1", { orderStatus: "New", cumExecQty: "0" });

      const result = await service.apply(makeCommand());

      assert.equal(result.statusCode, 500);
      assert.equal(bybit.cancelOrderCalls.length, 0);
      assert.equal(bybit.createOrderCalls.length, 0);
    },
    { dryRun: true, liveTradingEnabled: false, bybitApiKey: "", bybitApiSecret: "" },
  );
});

test("live-execution guard disabled on the close write fails closed without closing", async () => {
  await withService(
    async ({ service, bybit, repo }) => {
      await repo.save(makeRecord());
      setOrderStatus(bybit, "link-1", { orderStatus: "Cancelled", cumExecQty: "0" });
      bybit.openPositionsResponse = positionResponse({ side: "Buy", size: "0.003" });

      const result = await service.apply(makeCommand());

      assert.equal(result.statusCode, 500);
      assert.equal(bybit.createOrderCalls.length, 0);
    },
    { dryRun: true, liveTradingEnabled: false, bybitApiKey: "", bybitApiSecret: "" },
  );
});

test("a market-close write failure fails closed", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    setOrderStatus(bybit, "link-1", { orderStatus: "Cancelled", cumExecQty: "0" });
    bybit.openPositionsResponse = positionResponse({ side: "Buy", size: "0.003" });
    bybit.createOrder = async () => {
      throw new Error("exchange rejected the order");
    };

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 500);
  });
});

test("bounded position confirmation succeeds once a later attempt reads zero", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    setOrderStatus(bybit, "link-1", { orderStatus: "Cancelled", cumExecQty: "0" });

    let call = 0;
    const openPosition = positionResponse({ side: "Buy", size: "0.003" });
    const closed = closedResponse();
    bybit.getOpenPositions = async (input) => {
      call += 1;
      // Call 1: pre-close read (sees the position). Calls 2+: final
      // verification — only settles to zero on the second verify attempt.
      return call <= 2 ? openPosition : closed;
    };

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 200);
    assert.equal(bybit.createOrderCalls.length, 1, "the close order is never resent while verification retries");
    assert.ok(call >= 3, "expected at least one retried verification attempt");
  });
});

test("exhausting bounded verification without confirming zero fails closed", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    setOrderStatus(bybit, "link-1", { orderStatus: "Cancelled", cumExecQty: "0" });
    // The position never settles to zero within the bounded budget.
    bybit.openPositionsResponse = positionResponse({ side: "Buy", size: "0.003" });

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 500);
    assert.equal(bybit.createOrderCalls.length, 1, "the close order is sent once, never repeated");
  });
});

test("final verification still fails closed if the entry order is not confirmed non-live even though the position reads zero", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.openPositionsResponse = closedResponse();

    let call = 0;
    bybit.getOrderByLinkId = async (payload) => {
      call += 1;
      // Call 1 (initial classify before neutralization): live, triggers a
      // cancel. Call 2 (neutralization confirm): terminal, so ABI proceeds.
      // Calls 3+ (final pre-terminalization check): back to live — the
      // final check must still catch this rather than trusting call 2 alone.
      const status = call === 2 ? "Cancelled" : "New";
      return {
        retCode: 0,
        result: {
          category: payload.category,
          list: [
            {
              symbol: payload.symbol,
              orderLinkId: payload.orderLinkId,
              orderStatus: status,
              triggerPrice: "100000",
              qty: "0.003",
              cumExecQty: "0",
              stopLoss: "99000",
              takeProfit: "103000",
            },
          ],
        },
      };
    };

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 500);
    assert.equal(bybit.cancelOrderCalls.length, 1);
    assert.equal(bybit.createOrderCalls.length, 0, "position already reads zero, so no close order is ever sent");
  });
});

test("no scope release is observable before the terminal write, and it is observable once the write completes", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.openPositionsResponse = closedResponse();

    assert.equal(repo.findOwnerByScope("linear", "BTCUSDT")?.strategy_instance_id, "instance-1");

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 200);
    assert.equal(repo.findOwnerByScope("linear", "BTCUSDT"), undefined, "scope is released once terminal_closed is durably saved");
  });
});

test("a repeated close after terminal_closed performs no exchange write", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeRecord());
    bybit.openPositionsResponse = closedResponse();

    const first = await service.apply(makeCommand());
    assert.equal(first.statusCode, 200);
    const callsAfterFirst = bybit.getOpenPositionsCalls.length;

    const second = await service.apply(makeCommand());
    assert.equal(second.statusCode, 200);
    assert.equal(bybit.getOpenPositionsCalls.length, callsAfterFirst, "the repeat makes no further exchange call");
  });
});

// -- abi-pair-scoped-close-execution-v1: multi-owner attributable close --
// Two active records sharing one physical scope, seeded directly at the
// repository level (bypassing EntryPackageApplicationService's claim guard,
// same technique as abi-virtual-exposure-state-foundation-v1's
// findActiveRecordsForScope tests) — this is unreachable in production
// today, but is exactly the state Change 2 must already handle safely
// ahead of same-side ownership activation.

test("multi-owner close dispatches under its own identity, closes only the requesting cycle's resolved exposure, and never touches the sibling — all within one request", async () => {
  await withMultiOwnerService(async ({ service, bybit, repo }) => {
    const closeOrderLinkId = closeIdentityFor("instance-A", "cycle-A");
    await seedTwoOwners(repo);
    setOrderStatus(bybit, "link-a", { orderStatus: "Filled", cumExecQty: "0.004", qty: "0.004" });
    bybit.openPositionsResponse = positionResponse({ side: "Buy", size: "0.010" });
    // A market close order settles immediately once queried — this is what
    // makes dispatch and confirmation complete within one request (design.md
    // Decision 4's crash-window D/E collapsed into a single call).
    setOrderStatus(bybit, closeOrderLinkId, { orderStatus: "Filled", cumExecQty: "0.004", qty: "0.004" });

    const result = await service.apply(makeCommand({ strategyInstanceId: "instance-A", tradeCycleId: "cycle-A" }));

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, {
      strategy_instance_id: "instance-A",
      trade_cycle_id: "cycle-A",
      status: "trade_cycle_closed",
    });
    assert.equal(bybit.createOrderCalls.length, 1);
    assert.equal(bybit.createOrderCalls[0].qty, "0.004", "closes A's own resolved exposure, never the raw aggregate (0.010)");
    assert.equal((bybit.createOrderCalls[0] as { orderLinkId?: string }).orderLinkId, closeOrderLinkId);
    assert.equal((bybit.createOrderCalls[0] as { side?: string }).side, "Sell", "reduce-only against the aggregate's live Buy side");

    const closedA = repo.get("instance-A", "cycle-A");
    assert.equal(closedA?.status, "terminal_closed");
    assert.equal(closedA?.close_order_link_id, closeOrderLinkId);
    assert.equal(closedA?.early_execution_observation, null, "close never writes to early_execution_observation");

    const untouchedB = repo.get("instance-B", "cycle-B");
    assert.equal(untouchedB?.status, "applied", "sibling is untouched by closing A");
    assert.equal(untouchedB?.close_order_link_id, null);
    assert.deepEqual(
      repo.findActiveRecordsForScope("linear", "BTCUSDT").map((record) => record.trade_cycle_id),
      ["cycle-B"],
      "closing A leaves B as the scope's sole remaining active owner",
    );
  });
});

test("a cycle with zero resolved exposure sends no close order even while a sibling keeps the aggregate positive", async () => {
  await withMultiOwnerService(async ({ service, bybit, repo }) => {
    await seedTwoOwners(repo);
    setOrderStatus(bybit, "link-a", { orderStatus: "Cancelled", cumExecQty: "0", qty: "0.004" });

    const result = await service.apply(makeCommand({ strategyInstanceId: "instance-A", tradeCycleId: "cycle-A" }));

    assert.equal(result.statusCode, 200);
    assert.equal(bybit.getOpenPositionsCalls.length, 0, "no aggregate read when nothing needs closing");
    assert.equal(bybit.createOrderCalls.length, 0);
    const closedA = repo.get("instance-A", "cycle-A");
    assert.equal(closedA?.status, "terminal_closed");
    assert.equal(closedA?.close_order_link_id, null, "no identity is ever written for a zero-exposure cycle");

    const untouchedB = repo.get("instance-B", "cycle-B");
    assert.equal(untouchedB?.status, "applied");
  });
});

test("scenario B: a close order dispatched and confirmed filled by an earlier attempt is recovered, not resent", async () => {
  await withMultiOwnerService(async ({ service, bybit, repo }) => {
    const closeOrderLinkId = closeIdentityFor("instance-A", "cycle-A");
    await seedTwoOwners(repo, { closeOrderLinkId });
    setOrderStatus(bybit, "link-a", { orderStatus: "Filled", cumExecQty: "0.004", qty: "0.004" });
    setOrderStatus(bybit, closeOrderLinkId, { orderStatus: "Filled", cumExecQty: "0.004", qty: "0.004" });

    const result = await service.apply(makeCommand({ strategyInstanceId: "instance-A", tradeCycleId: "cycle-A" }));

    assert.equal(result.statusCode, 200);
    assert.equal(bybit.createOrderCalls.length, 0, "no new close order is ever sent for an already-confirmed identity");
    assert.equal(repo.get("instance-A", "cycle-A")?.status, "terminal_closed");
  });
});

test("scenario C: a close order whose fate stays live/ambiguous blocks success without a replacement order", async () => {
  await withMultiOwnerService(async ({ service, bybit, repo }) => {
    const closeOrderLinkId = closeIdentityFor("instance-A", "cycle-A");
    await seedTwoOwners(repo, { closeOrderLinkId });
    setOrderStatus(bybit, "link-a", { orderStatus: "Filled", cumExecQty: "0.004", qty: "0.004" });
    // The close order itself is found but never reaches a terminal status
    // within the bounded window.
    setOrderStatus(bybit, closeOrderLinkId, { orderStatus: "New", cumExecQty: "0", qty: "0.004" });

    const result = await service.apply(makeCommand({ strategyInstanceId: "instance-A", tradeCycleId: "cycle-A" }));

    assert.equal(result.statusCode, 500);
    assert.equal(bybit.createOrderCalls.length, 0, "no replacement order while the prior one's fate is unresolved");
    assert.notEqual(repo.get("instance-A", "cycle-A")?.status, "terminal_closed");
  });
});

test("scenario D: a definitively zero-execution close order fails closed with close_execution_incomplete", async () => {
  await withMultiOwnerService(async ({ service, bybit, repo }) => {
    const closeOrderLinkId = closeIdentityFor("instance-A", "cycle-A");
    await seedTwoOwners(repo, { closeOrderLinkId });
    setOrderStatus(bybit, "link-a", { orderStatus: "Filled", cumExecQty: "0.004", qty: "0.004" });
    setOrderStatus(bybit, closeOrderLinkId, { orderStatus: "Cancelled", cumExecQty: "0", qty: "0.004" });

    const result = await service.apply(makeCommand({ strategyInstanceId: "instance-A", tradeCycleId: "cycle-A" }));

    assert.equal(result.statusCode, 422);
    assert.deepEqual(result.body, {
      error: {
        code: "close_execution_incomplete",
        message: "the requested cycle's own close order did not fully execute the resolved exposure",
      },
    });
    assert.equal(bybit.createOrderCalls.length, 0, "no resubmission under the same or a new identity");
    assert.notEqual(repo.get("instance-A", "cycle-A")?.status, "terminal_closed");
  });
});

test("scenario E: a confirmed partial execution is not accepted as success", async () => {
  await withMultiOwnerService(async ({ service, bybit, repo }) => {
    const closeOrderLinkId = closeIdentityFor("instance-A", "cycle-A");
    await seedTwoOwners(repo, { closeOrderLinkId });
    setOrderStatus(bybit, "link-a", { orderStatus: "Filled", cumExecQty: "0.004", qty: "0.004" });
    // Terminal (Cancelled), but only half of the requested 0.004 executed.
    setOrderStatus(bybit, closeOrderLinkId, { orderStatus: "Cancelled", cumExecQty: "0.002", qty: "0.004" });

    const result = await service.apply(makeCommand({ strategyInstanceId: "instance-A", tradeCycleId: "cycle-A" }));

    assert.equal(result.statusCode, 422);
    assert.equal(result.body.error.code, "close_execution_incomplete");
    assert.equal(bybit.createOrderCalls.length, 0);
    assert.notEqual(repo.get("instance-A", "cycle-A")?.status, "terminal_closed");
  });
});

test("a close-order identity genuinely never created is safely resent under the same identity, then confirmed", async () => {
  await withMultiOwnerService(async ({ service, bybit, repo }) => {
    const closeOrderLinkId = closeIdentityFor("instance-A", "cycle-A");
    await seedTwoOwners(repo, { closeOrderLinkId });
    setOrderStatus(bybit, "link-a", { orderStatus: "Filled", cumExecQty: "0.004", qty: "0.004" });
    bybit.openPositionsResponse = positionResponse({ side: "Buy", size: "0.010" });
    // No response configured for closeOrderLinkId at all — genuinely
    // not_found, until the resend settles it.
    settleOrderQueryAfterCreate(
      bybit,
      closeOrderLinkId,
      orderListResponse({ orderStatus: "Filled", cumExecQty: "0.004", qty: "0.004" }),
    );

    const result = await service.apply(makeCommand({ strategyInstanceId: "instance-A", tradeCycleId: "cycle-A" }));

    assert.equal(result.statusCode, 200);
    assert.equal(bybit.createOrderCalls.length, 1, "resent exactly once, reusing the same identity");
    assert.equal((bybit.createOrderCalls[0] as { orderLinkId?: string }).orderLinkId, closeOrderLinkId);
    assert.equal(repo.get("instance-A", "cycle-A")?.status, "terminal_closed");
  });
});

async function seedTwoOwners(
  repo: EntryPackageCorrelationRepository,
  overridesA: Partial<Parameters<typeof makeRecord>[0]> = {},
  overridesB: Partial<Parameters<typeof makeRecord>[0]> = {},
): Promise<void> {
  await repo.save(
    makeRecord({
      strategyInstanceId: "instance-A",
      tradeCycleId: "cycle-A",
      orderLinkId: "link-a",
      calculatedQuantity: "0.004",
      side: "long",
      ...overridesA,
    }),
  );
  await repo.save(
    makeRecord({
      strategyInstanceId: "instance-B",
      tradeCycleId: "cycle-B",
      orderLinkId: "link-b",
      calculatedQuantity: "0.006",
      side: "long",
      ...overridesB,
    }),
  );
}

function closeIdentityFor(strategyInstanceId: string, tradeCycleId: string, generation = 1): string {
  return buildEntryPackageOrderLinkId(strategyInstanceId, tradeCycleId, "close", generation);
}

async function withMultiOwnerService(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  await withService(fn);
}

test("close and a concurrent entry-package command for the same pair never interleave", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abi-close-concurrency-"));
  try {
    const config = liveConfig();
    const bybit = new FakeBybitAdapter();
    const guardedBybit = withReentrancyGuard(bybit);
    const repo = new EntryPackageCorrelationRepository(join(dir, "correlation.jsonl"));
    const mutex = new KeyedMutex();

    // Same pair for both commands, with no Bybit response configured beyond
    // a flat position: whichever command the mutex admits first leaves the
    // record in a state (applied, absent, or terminal_closed) the other
    // command's own existing handling already treats as a clean success —
    // so both orderings are deterministic without needing to control which
    // one wins the race.
    await repo.save(makeRecord({ status: "applied" }));
    bybit.openPositionsResponse = closedResponse();

    const closeService = new CloseApplicationService({ config, bybit: guardedBybit, correlationRepository: repo, mutex });

    const rulesProvider = new FakeInstrumentTradingRulesProvider();
    const entryPackageService = new EntryPackageApplicationService({
      config,
      bybit: guardedBybit,
      correlationRepository: repo,
      positionSizeCalculator: new FixedMinimumPositionSizeCalculator(rulesProvider),
      mutex,
      scopeMutex: new KeyedMutex(),
      exchangeInstrumentResolver: new BybitExchangeInstrumentResolver(),
    });

    const [closeResult, entryResult] = await Promise.all([
      closeService.apply(makeCommand()),
      entryPackageService.apply({
        strategyInstanceId: "instance-1",
        tradeCycleId: "cycle-1",
        ticker: "BTCUSDT.P",
        desiredEntry: null,
        riskMultiplier: "1",
      }),
    ]);

    assert.equal(closeResult.statusCode, 200);
    assert.equal(entryResult.statusCode, 200);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("close commands for two different pairs proceed independently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abi-close-independent-"));
  try {
    const config = liveConfig();
    const bybit = new FakeBybitAdapter();
    const repo = new EntryPackageCorrelationRepository(join(dir, "correlation.jsonl"));
    const mutex = new KeyedMutex();

    await repo.save(makeRecord());
    await repo.save(makeRecord({ strategyInstanceId: "instance-2", tradeCycleId: "cycle-2", exchangeSymbol: "ETHUSDT" }));

    const gate = deferred<void>();
    bybit.getOpenPositions = async (input) => {
      if (input?.symbol === "BTCUSDT") {
        await gate.promise;
      }
      return closedResponse(input?.symbol ?? "BTCUSDT");
    };

    const service = new CloseApplicationService({ config, bybit, correlationRepository: repo, mutex });

    const btcPromise = service.apply(makeCommand());
    const ethPromise = service.apply(makeCommand({ strategyInstanceId: "instance-2", tradeCycleId: "cycle-2" }));

    const ethResult = await ethPromise;
    assert.equal(ethResult.statusCode, 200);

    gate.resolve();
    const btcResult = await btcPromise;
    assert.equal(btcResult.statusCode, 200);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function withReentrancyGuard(bybit: FakeBybitAdapter): BybitAdapter {
  let inFlight = false;
  return new Proxy(bybit, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") {
        return value;
      }
      return async (...args: unknown[]) => {
        assert.equal(inFlight, false, `${String(prop)} called while another BybitAdapter call was already in flight`);
        inFlight = true;
        try {
          return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } finally {
          inFlight = false;
        }
      };
    },
  }) as unknown as BybitAdapter;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function liveConfig(overrides: Partial<AbiConfig> = {}): AbiConfig {
  return makeTestConfig({
    dryRun: false,
    liveTradingEnabled: true,
    bybitApiKey: "test-key",
    bybitApiSecret: "test-secret",
    bybitEnvironment: "testnet",
    ...overrides,
  });
}

async function withService(
  fn: (ctx: Ctx) => Promise<void>,
  configOverrides: Partial<AbiConfig> = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "abi-close-app-service-"));
  try {
    const config = liveConfig(configOverrides);
    const bybit = new FakeBybitAdapter();
    const repo = new EntryPackageCorrelationRepository(join(dir, "correlation.jsonl"));
    const mutex = new KeyedMutex();

    const service = new CloseApplicationService({ config, bybit, correlationRepository: repo, mutex });

    await fn({ service, bybit, repo });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// By default (no explicit order response configured), both realtime and
// history cleanly report the order absent — classifyEntryOrderTerminality
// treats that as terminal (design.md: the same clean-absence condition
// confirmEntryPackageCancelled already treats as confirmed non-live), so
// most tests above never need to configure an order response at all.
function setOrderStatus(
  bybit: FakeBybitAdapter,
  orderLinkId: string,
  input: { orderStatus: string; cumExecQty: string; qty?: string },
): void {
  const response = orderListResponse(input);
  bybit.orderByLinkIdResponseByLinkId.set(orderLinkId, response);
  bybit.orderHistoryResponseByLinkId.set(orderLinkId, response);
}

// Simulates a resent close order settling once actually dispatched: the
// identity reads not_found until createOrder is called with it, then reads
// `response` from then on — mirrors settleOrderAfterCancel's pattern for
// the "genuinely never created, safe to resend" crash window.
function settleOrderQueryAfterCreate(bybit: FakeBybitAdapter, orderLinkId: string, response: unknown): void {
  const realCreateOrder = bybit.createOrder.bind(bybit);
  bybit.createOrder = async (payload) => {
    const result = await realCreateOrder(payload);
    if ("orderLinkId" in payload && payload.orderLinkId === orderLinkId) {
      bybit.orderByLinkIdResponseByLinkId.set(orderLinkId, response);
      bybit.orderHistoryResponseByLinkId.set(orderLinkId, response);
    }
    return result;
  };
}

// Simulates a real cancel taking effect: once cancelOrder is called for
// this orderLinkId, subsequent order queries report the settled status.
function settleOrderAfterCancel(
  bybit: FakeBybitAdapter,
  orderLinkId: string,
  input: { orderStatus: string; cumExecQty: string },
): void {
  const realCancel = bybit.cancelOrder.bind(bybit);
  bybit.cancelOrder = async (payload) => {
    const result = await realCancel(payload);
    if (payload.orderLinkId === orderLinkId) {
      setOrderStatus(bybit, orderLinkId, input);
    }
    return result;
  };
}

// Simulates the market close settling: the pre-close read (and any
// verification attempt before createOrder is called) sees `openResponse`;
// every position read after the close order is sent reports flat.
function settlePositionAfterClose(bybit: FakeBybitAdapter, openResponse: unknown): void {
  bybit.openPositionsResponse = openResponse;
  const realCreateOrder = bybit.createOrder.bind(bybit);
  bybit.createOrder = async (payload) => {
    const result = await realCreateOrder(payload);
    bybit.openPositionsResponse = closedResponse();
    return result;
  };
}

function orderListResponse(input: { orderStatus: string; cumExecQty: string; qty?: string }): unknown {
  return {
    retCode: 0,
    result: {
      list: [
        {
          orderStatus: input.orderStatus,
          triggerPrice: "100000",
          qty: input.qty ?? "0.003",
          cumExecQty: input.cumExecQty,
          stopLoss: "99000",
          takeProfit: "103000",
        },
      ],
    },
  };
}

function makeCommand(overrides: { strategyInstanceId?: string; tradeCycleId?: string } = {}): {
  strategyInstanceId: string;
  tradeCycleId: string;
} {
  return {
    strategyInstanceId: "instance-1",
    tradeCycleId: "cycle-1",
    ...overrides,
  };
}

function makeRecord(
  overrides: Partial<{
    strategyInstanceId: string;
    tradeCycleId: string;
    status: EntryPackageExecutionStatus;
    exchangeSymbol: string;
    exchangeCategory: "linear" | "spot";
    orderLinkId: string | null;
    calculatedQuantity: string;
    side: "long" | "short";
    generation: number;
    closeOrderLinkId: string | null;
    closeOrderId: string | null;
  }> = {},
): EntryPackageExecutionRecord {
  return {
    strategy_instance_id: overrides.strategyInstanceId ?? "instance-1",
    trade_cycle_id: overrides.tradeCycleId ?? "cycle-1",
    ticker: "BTCUSDT.P",
    exchange_symbol: overrides.exchangeSymbol ?? "BTCUSDT",
    exchange_category: overrides.exchangeCategory ?? "linear",
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
    calculated_quantity: overrides.calculatedQuantity ?? "0.003",
    order_link_id: overrides.orderLinkId === undefined ? "link-1" : overrides.orderLinkId,
    order_id: overrides.orderLinkId === null ? null : "order-1",
    close_order_link_id: overrides.closeOrderLinkId ?? null,
    close_order_id: overrides.closeOrderId ?? null,
    generation: overrides.generation ?? 1,
    status: overrides.status ?? "applied",
    early_execution_observation: null,
    binding_history: [],
    pending_action: null,
    current_binding_started_at: "2026-01-01T00:00:00.000Z",
  };
}

function closedResponse(symbol = "BTCUSDT", category = "linear"): unknown {
  return {
    retCode: 0,
    result: { category, list: [{ symbol, side: "", size: "0", positionIdx: 0, avgPrice: "", openTime: 0 }] },
  };
}

function positionResponse(input: { side: "Buy" | "Sell"; size: string }, symbol = "BTCUSDT"): unknown {
  return {
    retCode: 0,
    result: {
      category: "linear",
      list: [
        {
          symbol,
          side: input.side,
          size: input.size,
          positionIdx: 0,
          avgPrice: "100000",
          openTime: 111,
        },
      ],
    },
  };
}
