import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { KeyedMutex } from "../../src/concurrency/keyedMutex.js";
import type { AbiConfig } from "../../src/config/config.js";
import { EntryPackageCorrelationRepository } from "../../src/correlation/entryPackageCorrelationRepository.js";
import type { DesiredEntryDto, EntryPackageCommand, EntryPackageHttpResult } from "../../src/domain/entryPackageApi.js";
import { BybitExchangeInstrumentResolver } from "../../src/exchange/exchangeInstrumentResolver.js";
import type { ExchangeInstrumentResolver } from "../../src/exchange/exchangeInstrumentResolver.js";
import { FixedMinimumPositionSizeCalculator } from "../../src/risk/positionSizeCalculator.js";
import { EntryPackageApplicationService } from "../../src/services/entryPackage/entryPackageApplicationService.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";
import { FakeInstrumentTradingRulesProvider } from "../fakes/fakeInstrumentTradingRulesProvider.js";
import { makeTestConfig } from "../fixtures/config.js";

type Ctx = {
  service: EntryPackageApplicationService;
  bybit: FakeBybitAdapter;
  repo: EntryPackageCorrelationRepository;
  rulesProvider: FakeInstrumentTradingRulesProvider;
};

test("first APPLY creates a live order and confirms application", async () => {
  await withService(async ({ service, bybit }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);

    const result = await service.apply(makeCommand());

    assertApplied(result, "0.001");
    assert.equal(bybit.createOrderCalls.length, 1);
  });
});

test("identical repeated APPLY revalidates without a duplicate create", async () => {
  await withService(async ({ service, bybit }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);

    await service.apply(makeCommand());
    const second = await service.apply(makeCommand());

    assertApplied(second, "0.001");
    assert.equal(bybit.createOrderCalls.length, 1);
    assert.ok(bybit.getOrderByLinkIdCalls.length >= 2);
  });
});

test("REPLACE via amend when only price/stop/take change (side unchanged)", async () => {
  await withService(async ({ service, bybit }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    await service.apply(makeCommand());

    bybit.orderByLinkIdResponse = orderList([
      liveOrder({ triggerPrice: "101000", stopLoss: "100000", takeProfit: "104000" }),
    ]);
    const second = await service.apply(
      makeCommand({
        desiredEntry: makeDesiredEntry({
          planned_entry_price: "101000",
          initial_stop_price: "100000",
          initial_take_price: "104000",
        }),
      }),
    );

    assertApplied(second, "0.001");
    assert.equal(bybit.amendOrderCalls.length, 1);
    assert.equal(bybit.createOrderCalls.length, 1);
    assert.equal(bybit.cancelOrderCalls.length, 0);
  });
});

test("REPLACE via cancel-and-create when side changes: confirms the old order cancelled before creating the new one", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    await service.apply(makeCommand());
    const firstOrderLinkId = repo.get("instance-1", "cycle-1")?.order_link_id;
    assert.ok(firstOrderLinkId);

    // The old order must confirm cancelled (not found) before the new,
    // opposite-side order is created; the shared default response
    // represents the *new* order once it exists.
    bybit.orderByLinkIdResponseByLinkId.set(firstOrderLinkId, orderList([]));
    bybit.orderByLinkIdResponse = orderList([
      liveOrder({ triggerPrice: "100000", stopLoss: "101000", takeProfit: "97000" }),
    ]);
    const second = await service.apply(
      makeCommand({
        desiredEntry: makeDesiredEntry({ side: "short", initial_stop_price: "101000", initial_take_price: "97000" }),
      }),
    );

    assertApplied(second, "0.001");
    assert.equal(bybit.cancelOrderCalls.length, 1);
    assert.equal(bybit.createOrderCalls.length, 2);

    const record = repo.get("instance-1", "cycle-1");
    assert.notEqual(record?.order_link_id, firstOrderLinkId);
    assert.equal(record?.generation, 2);
    assert.equal(record?.binding_history.length, 1);
    assert.equal(record?.binding_history[0]?.end_reason, "replaced");
  });
});

test("REPLACE via cancel-and-create: a fill discovered while confirming the cancel aborts creating a second order", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    await service.apply(makeCommand());
    const firstOrderLinkId = repo.get("instance-1", "cycle-1")?.order_link_id;
    assert.ok(firstOrderLinkId);

    bybit.orderByLinkIdResponseByLinkId.set(
      firstOrderLinkId,
      orderList([{ orderStatus: "Filled", cumExecQty: "0.001" }]),
    );

    const createCallsBefore = bybit.createOrderCalls.length;
    const result = await service.apply(
      makeCommand({
        desiredEntry: makeDesiredEntry({ side: "short", initial_stop_price: "101000", initial_take_price: "97000" }),
      }),
    );

    assertInternalError(result);
    assert.equal(bybit.createOrderCalls.length, createCallsBefore, "no second order created while the first may be live");

    const record = repo.get("instance-1", "cycle-1");
    assert.equal(record?.status, "applied");
    assert.equal(record?.order_link_id, firstOrderLinkId, "old binding is untouched, not replaced");
  });
});

test("successful CANCEL returns absent after durable confirmation", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    await service.apply(makeCommand());

    bybit.orderByLinkIdResponse = orderList([]);
    bybit.orderHistoryResponse = orderList([]);
    const result = await service.apply(makeCommand({ desiredEntry: null }));

    assertAbsent(result);
    assert.equal(bybit.cancelOrderCalls.length, 1);

    const record = repo.get("instance-1", "cycle-1");
    assert.equal(record?.status, "absent");
    assert.equal(record?.order_link_id, null);
    assert.equal(record?.binding_history[0]?.end_reason, "cancelled");
  });
});

test("CANCEL with a malformed confirmation response never returns entry_package_absent and leaves state unresolved", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    await service.apply(makeCommand());
    const orderLinkId = repo.get("instance-1", "cycle-1")?.order_link_id;
    assert.ok(orderLinkId);

    bybit.orderByLinkIdResponse = malformedResponse();
    bybit.orderHistoryResponse = malformedResponse();
    const result = await service.apply(makeCommand({ desiredEntry: null }));

    assertInternalError(result);
    const record = repo.get("instance-1", "cycle-1");
    assert.notEqual(record?.status, "absent");
    assert.equal(record?.status, "unknown");
    assert.equal(record?.order_link_id, orderLinkId, "the record does not become absent");
  });
});

test("a spot ticker (no .P suffix) uses category=spot end-to-end, never the global bybitCategory default", async () => {
  await withService(async ({ service, bybit, repo, rulesProvider }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    await service.apply(makeCommand({ ticker: "BTCUSDT" }));

    const record = repo.get("instance-1", "cycle-1");
    assert.equal(record?.exchange_symbol, "BTCUSDT");
    assert.equal(record?.exchange_category, "spot");
    assert.equal(bybit.createOrderCalls[0]?.category, "spot");
    assert.deepEqual(rulesProvider.getRulesCalls, ["spot:BTCUSDT"]);
    for (const call of bybit.getOrderByLinkIdCalls) {
      assert.equal(call.category, "spot");
    }

    bybit.orderByLinkIdResponse = orderList([]);
    bybit.orderHistoryResponse = orderList([]);
    const cancelResult = await service.apply(makeCommand({ ticker: "BTCUSDT", desiredEntry: null }));

    assertAbsent(cancelResult);
    assert.equal(bybit.cancelOrderCalls[0]?.category, "spot");
    for (const call of bybit.getOrderByLinkIdCalls) {
      assert.equal(call.category, "spot");
    }
    for (const call of bybit.getOrderHistoryCalls) {
      assert.equal(call.category, "spot");
    }
  });
});

test("already-absent CANCEL makes no exchange call", async () => {
  await withService(async ({ service, bybit }) => {
    const result = await service.apply(makeCommand({ desiredEntry: null }));

    assertAbsent(result);
    assert.equal(bybit.cancelOrderCalls.length, 0);
    assert.equal(bybit.createOrderCalls.length, 0);
  });
});

test("create transport failure returns a safe error and never a fabricated success", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.createOrder = async () => {
      throw new Error("transport failure");
    };

    const result = await service.apply(makeCommand());

    assertInternalError(result);
    // A thrown exception during the exchange call means we genuinely don't
    // know whether Bybit received it — "unknown", not a definitive
    // "create_failed", so a later retry still resends rather than being
    // permanently written off.
    assert.equal(repo.get("instance-1", "cycle-1")?.status, "unknown");
  });
});

test("create accepted but confirmation ambiguous returns a safe error", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.orderByLinkIdResponse = orderList([]);
    bybit.orderHistoryResponse = orderList([]);

    const result = await service.apply(makeCommand());

    assertInternalError(result);
    assert.equal(repo.get("instance-1", "cycle-1")?.status, "unknown");
  });
});

test("create accepted but confirmation malformed never fabricates success: internal_error, status unknown, pending_action preserved", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.orderByLinkIdResponse = malformedResponse();
    bybit.orderHistoryResponse = malformedResponse();

    const result = await service.apply(makeCommand());

    assertInternalError(result);
    const record = repo.get("instance-1", "cycle-1");
    assert.equal(record?.status, "unknown");
    assert.equal(record?.pending_action, "create");
  });
});

test("a repeat PUT after a malformed confirmation never resends solely because the prior confirmation was malformed", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.orderByLinkIdResponse = malformedResponse();
    bybit.orderHistoryResponse = malformedResponse();

    const first = await service.apply(makeCommand());
    assertInternalError(first);
    assert.equal(bybit.createOrderCalls.length, 1);

    const second = await service.apply(makeCommand());
    assertInternalError(second);
    assert.equal(
      bybit.createOrderCalls.length,
      1,
      "a malformed confirmation is ambiguous, not not_found — it must never be treated as grounds to resend",
    );
    assert.equal(repo.get("instance-1", "cycle-1")?.status, "unknown");
  });
});

test("a create genuinely never dispatched (crash before Bybit ever saw it) self-heals: a repeat PUT resends create rather than staying stuck forever", async () => {
  await withService(async ({ service, bybit, repo }) => {
    // Nothing exists anywhere: the exchange genuinely never received the
    // first attempt (e.g. a crash before/during the create call, or the
    // create response was lost). Both queries cleanly return empty.
    bybit.orderByLinkIdResponse = orderList([]);
    bybit.orderHistoryResponse = orderList([]);

    const first = await service.apply(makeCommand());
    assertInternalError(first);
    assert.equal(repo.get("instance-1", "cycle-1")?.status, "unknown");
    assert.equal(bybit.createOrderCalls.length, 1);
    const firstOrderLinkId = repo.get("instance-1", "cycle-1")?.order_link_id;

    // Still nothing on the exchange: a repeat identical PUT must resend
    // create (proving the system doesn't get stuck forever in "unknown")
    // rather than only re-querying the same absent order indefinitely.
    const second = await service.apply(makeCommand());

    assertInternalError(second);
    assert.equal(bybit.createOrderCalls.length, 2, "the repeat PUT resent create rather than only re-querying");
    const afterResend = repo.get("instance-1", "cycle-1");
    assert.equal(afterResend?.order_link_id, firstOrderLinkId, "the resend reused the already-reserved identity");
    assert.equal(afterResend?.generation, 1, "still generation 1 — a resend, not a new binding");

    // Once the exchange actually shows the order, confirmation succeeds
    // without needing yet another resend.
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    const third = await service.apply(makeCommand());

    assertApplied(third, "0.001");
    assert.equal(bybit.createOrderCalls.length, 2, "no further resend once confirmation succeeds");
    const final = repo.get("instance-1", "cycle-1");
    assert.equal(final?.order_link_id, firstOrderLinkId);
    assert.equal(final?.generation, 1);
    assert.equal(final?.status, "applied");
  });
});

test("a risk_multiplier-only change on an otherwise-identical repeat PUT is durably persisted", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    await service.apply(makeCommand({ riskMultiplier: "1" }));
    assert.equal(repo.get("instance-1", "cycle-1")?.risk_multiplier, "1");

    const result = await service.apply(makeCommand({ riskMultiplier: "2" }));

    assertApplied(result, "0.001");
    assert.equal(repo.get("instance-1", "cycle-1")?.risk_multiplier, "2");
  });
});

test("REPLACE via amend reuses the order's recorded exchange_symbol/exchange_category rather than re-resolving the ticker", async () => {
  let resolveCount = 0;
  const driftingResolver: ExchangeInstrumentResolver = {
    resolve(ticker: string) {
      // Simulates resolution drifting between calls (e.g. a contract
      // rollover, or a category reclassification) — amend must not pick up
      // a new value mid-flight.
      const symbol = `${ticker.replace(/\.P$/, "")}-${resolveCount}`;
      const category = resolveCount === 0 ? "linear" : "spot";
      resolveCount += 1;
      return { ticker, symbol, category, product: category === "linear" ? "perpetual" : "spot" };
    },
  };

  await withService(
    async ({ service, bybit, repo, rulesProvider }) => {
      bybit.orderByLinkIdResponse = orderList([liveOrder()]);
      await service.apply(makeCommand());
      const originalSymbol = repo.get("instance-1", "cycle-1")?.exchange_symbol;
      const originalCategory = repo.get("instance-1", "cycle-1")?.exchange_category;
      assert.ok(originalSymbol);
      assert.equal(originalCategory, "linear");

      rulesProvider.getRulesCalls.length = 0;
      bybit.orderByLinkIdResponse = orderList([
        liveOrder({ triggerPrice: "101000", stopLoss: "100000", takeProfit: "104000" }),
      ]);
      const result = await service.apply(
        makeCommand({
          desiredEntry: makeDesiredEntry({
            planned_entry_price: "101000",
            initial_stop_price: "100000",
            initial_take_price: "104000",
          }),
        }),
      );

      assertApplied(result, "0.001");
      assert.equal(bybit.amendOrderCalls[0]?.symbol, originalSymbol);
      assert.equal(bybit.amendOrderCalls[0]?.category, originalCategory);
      assert.deepEqual(rulesProvider.getRulesCalls, [`${originalCategory}:${originalSymbol}`]);
      assert.equal(repo.get("instance-1", "cycle-1")?.exchange_symbol, originalSymbol);
      assert.equal(repo.get("instance-1", "cycle-1")?.exchange_category, originalCategory);
    },
    {},
    driftingResolver,
  );
});

test("terminal-without-fill fail-closed, then CANCEL, then a fresh CREATE gets a new generation", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    await service.apply(makeCommand());
    const firstOrderLinkId = repo.get("instance-1", "cycle-1")?.order_link_id;

    bybit.orderByLinkIdResponse = orderList([]);
    bybit.orderHistoryResponse = orderList([{ orderStatus: "Rejected", cumExecQty: "0" }]);
    const repeatResult = await service.apply(makeCommand());
    assertInternalError(repeatResult);
    assert.equal(repo.get("instance-1", "cycle-1")?.status, "terminal_unfilled");

    const blockedResult = await service.apply(makeCommand());
    assertInternalError(blockedResult);
    assert.equal(bybit.createOrderCalls.length, 1, "no new order created while terminal_unfilled");

    const cancelCallsBefore = bybit.cancelOrderCalls.length;
    const cancelResult = await service.apply(makeCommand({ desiredEntry: null }));
    assertAbsent(cancelResult);
    assert.equal(bybit.cancelOrderCalls.length, cancelCallsBefore, "no exchange call needed to leave terminal_unfilled");

    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    bybit.orderHistoryResponse = orderList([]);
    const freshCreateResult = await service.apply(makeCommand());
    assertApplied(freshCreateResult, "0.001");
    assert.equal(bybit.createOrderCalls.length, 2);

    const record = repo.get("instance-1", "cycle-1");
    assert.notEqual(record?.order_link_id, firstOrderLinkId);
    assert.equal(record?.generation, 2);
  });
});

test("a changed ticker within an existing trade cycle is rejected without contacting the exchange", async () => {
  await withService(async ({ service, bybit }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    await service.apply(makeCommand());

    const createCallsBefore = bybit.createOrderCalls.length;
    const amendCallsBefore = bybit.amendOrderCalls.length;
    const cancelCallsBefore = bybit.cancelOrderCalls.length;

    const result = await service.apply(makeCommand({ ticker: "ETHUSDT.P" }));

    assertInternalError(result);
    assert.equal(bybit.createOrderCalls.length, createCallsBefore);
    assert.equal(bybit.amendOrderCalls.length, amendCallsBefore);
    assert.equal(bybit.cancelOrderCalls.length, cancelCallsBefore);
  });
});

test("metadata-only change durably updates without sending an amend or create request", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    await service.apply(makeCommand());

    const result = await service.apply(
      makeCommand({ desiredEntry: makeDesiredEntry({ locked_exit_profile: "scratch" }) }),
    );

    assertApplied(result, "0.001");
    assert.equal(bybit.createOrderCalls.length, 1);
    assert.equal(bybit.amendOrderCalls.length, 0);
    assert.equal(repo.get("instance-1", "cycle-1")?.desired_entry?.locked_exit_profile, "scratch");
  });
});

test("skipped_live_execution never produces entry_package_applied or entry_package_absent", async () => {
  await withService(
    async ({ service, bybit }) => {
      const result = await service.apply(makeCommand());

      assertInternalError(result);
      assert.equal(bybit.createOrderCalls.length, 0);
    },
    { dryRun: true, liveTradingEnabled: false, bybitApiKey: "", bybitApiSecret: "" },
  );
});

test("concurrent identical PUT produces exactly one exchange create order", async () => {
  await withService(async ({ service, bybit }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);

    const [first, second] = await Promise.all([service.apply(makeCommand()), service.apply(makeCommand())]);

    assertApplied(first, "0.001");
    assertApplied(second, "0.001");
    assert.equal(bybit.createOrderCalls.length, 1);
  });
});

test("concurrent differing PUT does not interleave: second request completes only after the first", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);

    const secondDesiredEntry = makeDesiredEntry({
      planned_entry_price: "101000",
      initial_stop_price: "100000",
      initial_take_price: "104000",
    });

    const firstPromise = service.apply(makeCommand());
    const secondPromise = service.apply(makeCommand({ desiredEntry: secondDesiredEntry }));

    // The first request's confirmation query needs matching fields; the
    // second (amend) request's confirmation needs the amended fields. Since
    // the mutex serializes them, swap the fake's response once the first
    // create call has actually gone out.
    await waitUntil(() => bybit.createOrderCalls.length >= 1);
    bybit.orderByLinkIdResponse = orderList([
      liveOrder({ triggerPrice: "101000", stopLoss: "100000", takeProfit: "104000" }),
    ]);

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    assertApplied(first, "0.001");
    assertApplied(second, "0.001");
    assert.equal(bybit.createOrderCalls.length, 1);
    assert.equal(bybit.amendOrderCalls.length, 1);
    assert.equal(repo.get("instance-1", "cycle-1")?.desired_entry?.planned_entry_price, "101000");
  });
});

test("a failing first request releases the mutex so a subsequent request for the same trade cycle still proceeds", async () => {
  await withService(async ({ service, bybit }) => {
    bybit.createOrder = async () => {
      throw new Error("transport failure");
    };

    const failed = await service.apply(makeCommand());
    assertInternalError(failed);

    bybit.createOrder = async (payload) => {
      bybit.createOrderCalls.push(payload);
      return { retCode: 0, result: { orderLinkId: "fake-create" } };
    };
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);

    const succeeded = await service.apply(makeCommand());
    assertApplied(succeeded, "0.001");
  });
});

function makeCommand(overrides: Partial<EntryPackageCommand> = {}): EntryPackageCommand {
  return {
    strategyInstanceId: "instance-1",
    tradeCycleId: "cycle-1",
    ticker: "BTCUSDT.P",
    desiredEntry: makeDesiredEntry(),
    riskMultiplier: "1",
    ...overrides,
  };
}

function makeDesiredEntry(overrides: Partial<DesiredEntryDto> = {}): DesiredEntryDto {
  return {
    side: "long",
    source_plan_bar_open_time_ms: 1785000000000,
    planned_entry_price: "100000",
    initial_stop_price: "99000",
    initial_take_price: "103000",
    locked_exit_profile: "runner",
    ...overrides,
  };
}

function liveOrder(
  overrides: Partial<{
    orderStatus: string;
    triggerPrice: string;
    qty: string;
    stopLoss: string;
    takeProfit: string;
  }> = {},
) {
  return {
    orderStatus: "New",
    triggerPrice: "100000",
    qty: "0.001",
    stopLoss: "99000",
    takeProfit: "103000",
    ...overrides,
  };
}

function orderList(items: unknown[]): unknown {
  return { retCode: 0, result: { list: items } };
}

// Structurally invalid: `list` present but not an array, so it can never
// be mistaken for a clean "not found" or a real found order.
function malformedResponse(): unknown {
  return { retCode: 0, result: { list: "not-an-array" } };
}

function assertApplied(result: EntryPackageHttpResult, calculatedQuantity: string): void {
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  const body = result.body as { status: string; calculated_quantity: string };
  assert.equal(body.status, "entry_package_applied");
  assert.equal(body.calculated_quantity, calculatedQuantity);
}

function assertAbsent(result: EntryPackageHttpResult): void {
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  const body = result.body as { status: string };
  assert.equal(body.status, "entry_package_absent");
}

function assertInternalError(result: EntryPackageHttpResult): void {
  assert.equal(result.statusCode, 500, JSON.stringify(result.body));
  const body = result.body as { error: { code: string } };
  assert.equal(body.error.code, "internal_error");
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  while (!predicate()) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function withService(
  fn: (ctx: Ctx) => Promise<void>,
  configOverrides: Partial<AbiConfig> = {},
  exchangeInstrumentResolver: ExchangeInstrumentResolver = new BybitExchangeInstrumentResolver(),
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "abi-entry-package-app-service-"));
  try {
    const config = makeTestConfig({
      dryRun: false,
      liveTradingEnabled: true,
      bybitApiKey: "test-key",
      bybitApiSecret: "test-secret",
      bybitEnvironment: "testnet",
      ...configOverrides,
    });
    const bybit = new FakeBybitAdapter();
    const repo = new EntryPackageCorrelationRepository(join(dir, "correlation.jsonl"));
    const rulesProvider = new FakeInstrumentTradingRulesProvider();
    const positionSizeCalculator = new FixedMinimumPositionSizeCalculator(rulesProvider);
    const mutex = new KeyedMutex();

    const service = new EntryPackageApplicationService({
      config,
      bybit,
      correlationRepository: repo,
      positionSizeCalculator,
      mutex,
      exchangeInstrumentResolver,
    });

    await fn({ service, bybit, repo, rulesProvider });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
