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
import type { DesiredEntryDto, EntryPackageCommand, EntryPackageHttpResult } from "../../src/domain/entryPackageApi.js";
import { BybitExchangeInstrumentResolver } from "../../src/exchange/exchangeInstrumentResolver.js";
import type { ExchangeInstrumentResolver } from "../../src/exchange/exchangeInstrumentResolver.js";
import { FixedMinimumPositionSizeCalculator } from "../../src/risk/positionSizeCalculator.js";
import { BybitInstrumentTradingRulesProvider } from "../../src/exchange/instrumentTradingRulesProvider.js";
import {
  EntryPackageApplicationService,
  exchangeBoundDesiredFields,
} from "../../src/services/entryPackage/entryPackageApplicationService.js";
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

test("a Filled row with a non-string numeric field never fabricates success: internal_error, status unknown, no entry_package_applied", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.orderByLinkIdResponse = {
      retCode: 0,
      result: {
        category: "linear",
        list: [
          {
            orderStatus: "Filled",
            cumExecQty: 0.001, // malformed: exchange field must be a string, never coerced
            avgPrice: "99950",
          },
        ],
      },
    };
    bybit.orderHistoryResponse = orderList([]);

    const result = await service.apply(makeCommand());

    assertInternalError(result);
    const record = repo.get("instance-1", "cycle-1");
    assert.equal(record?.status, "unknown");
    assert.notEqual((result.body as { status?: string }).status, "entry_package_applied");
  });
});

test("a malformed instruments-info response never fabricates success: internal_error, no createOrder, no applied record", async () => {
  await withRealRulesProviderService(async ({ service, bybit, repo }) => {
    bybit.instrumentInfoResponse = {
      retCode: 0,
      result: { category: "linear", list: [{ symbol: "BTCUSDT", lotSizeFilter: { minOrderQty: "0" } }] },
    };

    const result = await service.apply(makeCommand());

    assertInternalError(result);
    assert.equal(bybit.createOrderCalls.length, 0);
    const record = repo.get("instance-1", "cycle-1");
    assert.equal(record, undefined);
  });
});

test("an unsupported spot instruments-info lookup never fabricates success: internal_error, no createOrder, no applied record", async () => {
  await withRealRulesProviderService(async ({ service, bybit, repo }) => {
    bybit.instrumentInfoResponse = {
      retCode: 0,
      result: {
        category: "spot",
        list: [{ symbol: "BTCUSDT", lotSizeFilter: { basePrecision: "0.000001", minOrderAmt: "5" } }],
      },
    };

    const result = await service.apply(makeCommand({ ticker: "BTCUSDT" }));

    assertInternalError(result);
    assert.equal(bybit.createOrderCalls.length, 0);
    const record = repo.get("instance-1", "cycle-1");
    assert.equal(record, undefined);
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

// abi-close-execution-v1: a trade cycle close-execution has durably closed
// as terminal_closed must never be resurrected by a later entry-package
// request for the same pair (entry-package-execution's own ADDED
// requirement) — the same protection terminal_unfilled already has, but
// covering the distinct terminal_closed status this change introduces.
test("a terminal_closed trade cycle rejects a new non-null desiredEntry without creating an order", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeTerminalClosedRecord());

    const result = await service.apply(makeCommand());

    assertInternalError(result);
    assert.equal(bybit.createOrderCalls.length, 0);
    assert.equal(repo.get("instance-1", "cycle-1")?.status, "terminal_closed");
  });
});

test("a terminal_closed trade cycle acknowledges a null desiredEntry without altering the record or contacting the exchange", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(makeTerminalClosedRecord());

    const result = await service.apply(makeCommand({ desiredEntry: null }));

    assertAbsent(result);
    assert.equal(bybit.cancelOrderCalls.length, 0);
    assert.equal(repo.get("instance-1", "cycle-1")?.status, "terminal_closed");
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

// --- Confirmation compares against the exchange-bound write, not a
// re-derived DesiredEntryDto value ---
//
// Every scenario below drives the live/history read-back from the literal
// payload the service actually sent to (or, for the two revalidation-only
// paths, previously sent to) Bybit — captured off the fake adapter's own
// call log rather than duplicated as a second, independently-typed literal
// in the test. A regression that made confirmation compare against
// DesiredEntryDto (or any other re-derived source) instead of the real
// write would only coincidentally pass these positive cases while the
// mapper stays an identity passthrough, so each is paired with a mismatch
// variant: one field of the read-back is perturbed away from what was
// actually sent, and the outcome must still fail closed (never
// entry_package_applied, status never "applied").

test("exchangeBoundDesiredFields derives every field from the write payload actually built for Bybit", () => {
  const desired = exchangeBoundDesiredFields({
    triggerPrice: "101000",
    qty: "0.007",
    stopLoss: "99500",
    takeProfit: "104250",
  });

  assert.deepEqual(desired, {
    triggerPrice: "101000",
    qty: "0.007",
    stopLoss: "99500",
    takeProfit: "104250",
  });
});

test("exchangeBoundDesiredFields falls back to empty string for an omitted stopLoss/takeProfit rather than reaching outside the payload", () => {
  const desired = exchangeBoundDesiredFields({ triggerPrice: "101000", qty: "0.007" });

  assert.deepEqual(desired, {
    triggerPrice: "101000",
    qty: "0.007",
    stopLoss: "",
    takeProfit: "",
  });
});

test("post-create: confirmation matches the exact order just sent to Bybit, not a re-derived DesiredEntryDto value", async () => {
  await withService(async ({ service, bybit }) => {
    bybit.getOrderByLinkId = async () => {
      const sent = bybit.createOrderCalls[bybit.createOrderCalls.length - 1];
      assert.ok(sent, "create must have been sent before confirmation queries it back");
      return sentOrderResponse(sent);
    };

    const result = await service.apply(makeCommand());

    assertApplied(result, "0.001");
    assert.equal(bybit.createOrderCalls.length, 1);
  });
});

test("post-create: a real mismatch between the read-back and the actual sent order still fails closed", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.getOrderByLinkId = async () => {
      const sent = bybit.createOrderCalls[bybit.createOrderCalls.length - 1];
      assert.ok(sent, "create must have been sent before confirmation queries it back");
      // triggerPrice on the exchange genuinely differs from what was sent —
      // e.g. a corrupted echo — never a coincidental formatting difference.
      return sentOrderResponse(sent, { triggerPrice: "1" });
    };
    bybit.orderHistoryResponse = orderList([]);

    const result = await service.apply(makeCommand());

    assertInternalError(result);
    assert.equal(bybit.createOrderCalls.length, 1);
    const record = repo.get("instance-1", "cycle-1");
    assert.equal(record?.status, "unknown");
    assert.notEqual((result.body as { status?: string }).status, "entry_package_applied");
  });
});

test("post-amend (REPLACE): confirmation matches the exact amend just sent to Bybit, not a re-derived DesiredEntryDto value", async () => {
  await withService(async ({ service, bybit }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    await service.apply(makeCommand());

    bybit.getOrderByLinkId = async () => {
      const sent = bybit.amendOrderCalls[bybit.amendOrderCalls.length - 1];
      assert.ok(sent, "amend must have been sent before confirmation queries it back");
      return sentOrderResponse(sent);
    };

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
    assert.equal(bybit.amendOrderCalls.length, 1);
  });
});

test("post-amend (REPLACE): a real mismatch between the read-back and the actual sent amend still fails closed", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    await service.apply(makeCommand());

    bybit.getOrderByLinkId = async () => {
      const sent = bybit.amendOrderCalls[bybit.amendOrderCalls.length - 1];
      assert.ok(sent, "amend must have been sent before confirmation queries it back");
      // stopLoss on the exchange genuinely differs from what was just
      // amended to.
      return sentOrderResponse(sent, { stopLoss: "1" });
    };
    bybit.orderHistoryResponse = orderList([]);

    const result = await service.apply(
      makeCommand({
        desiredEntry: makeDesiredEntry({
          planned_entry_price: "101000",
          initial_stop_price: "100000",
          initial_take_price: "104000",
        }),
      }),
    );

    assertInternalError(result);
    assert.equal(bybit.amendOrderCalls.length, 1);
    const record = repo.get("instance-1", "cycle-1");
    assert.equal(record?.status, "unknown");
    assert.notEqual((result.body as { status?: string }).status, "entry_package_applied");
  });
});

test("repeat PUT revalidation: confirmation matches the order originally sent to Bybit, not a re-derived DesiredEntryDto value", async () => {
  await withService(async ({ service, bybit }) => {
    bybit.getOrderByLinkId = async () => {
      const sent = bybit.createOrderCalls[bybit.createOrderCalls.length - 1];
      assert.ok(sent, "create must have been sent before revalidation queries it back");
      return sentOrderResponse(sent);
    };

    await service.apply(makeCommand());
    const second = await service.apply(makeCommand());

    assertApplied(second, "0.001");
    assert.equal(bybit.createOrderCalls.length, 1, "an identical repeat PUT never resends a create");
  });
});

test("repeat PUT revalidation: a real mismatch against the originally sent order still fails closed", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    await service.apply(makeCommand());

    bybit.getOrderByLinkId = async () => {
      const sent = bybit.createOrderCalls[bybit.createOrderCalls.length - 1];
      assert.ok(sent, "create must have been sent before revalidation queries it back");
      // takeProfit on the exchange genuinely differs from what was
      // originally created — the exchange truly diverged from the binding.
      return sentOrderResponse(sent, { takeProfit: "1" });
    };
    bybit.orderHistoryResponse = orderList([]);

    const second = await service.apply(makeCommand());

    assertInternalError(second);
    assert.equal(bybit.createOrderCalls.length, 1, "a genuine exchange mismatch is never grounds to resend a create");
    const record = repo.get("instance-1", "cycle-1");
    assert.notEqual(record?.status, "applied");
  });
});

test("metadata-only revalidation: confirmation matches the order originally sent to Bybit, not a re-derived DesiredEntryDto value", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.getOrderByLinkId = async () => {
      const sent = bybit.createOrderCalls[bybit.createOrderCalls.length - 1];
      assert.ok(sent, "create must have been sent before revalidation queries it back");
      return sentOrderResponse(sent);
    };

    await service.apply(makeCommand());
    const second = await service.apply(
      makeCommand({ desiredEntry: makeDesiredEntry({ locked_exit_profile: "scratch" }) }),
    );

    assertApplied(second, "0.001");
    assert.equal(bybit.createOrderCalls.length, 1);
    assert.equal(bybit.amendOrderCalls.length, 0);
    assert.equal(repo.get("instance-1", "cycle-1")?.desired_entry?.locked_exit_profile, "scratch");
  });
});

test("metadata-only revalidation: a real mismatch against the originally sent order still fails closed", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    await service.apply(makeCommand());

    bybit.getOrderByLinkId = async () => {
      const sent = bybit.createOrderCalls[bybit.createOrderCalls.length - 1];
      assert.ok(sent, "create must have been sent before revalidation queries it back");
      return sentOrderResponse(sent, { triggerPrice: "1" });
    };
    bybit.orderHistoryResponse = orderList([]);

    const second = await service.apply(
      makeCommand({ desiredEntry: makeDesiredEntry({ locked_exit_profile: "scratch" }) }),
    );

    assertInternalError(second);
    assert.equal(bybit.createOrderCalls.length, 1);
    assert.equal(bybit.amendOrderCalls.length, 0, "revalidation never sends an amend regardless of the outcome");
    const record = repo.get("instance-1", "cycle-1");
    assert.notEqual(record?.status, "applied");
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

// Cross-pair scope tests deliberately vary both strategy_instance_id and
// trade_cycle_id, not trade_cycle_id alone: the target V1 model is
// "instance-A/cycle-A1 vs. instance-B/cycle-B1 both wanting BTCUSDT" —
// two cycles under the *same* instance is a state Runtime's own external
// invariant (at most one current trade cycle per strategy instance)
// already rules out, so it is not the scenario this mechanism exists for.
// ABI's own check only ever compares the full pair, but tests should read
// as the real model, not as an incidental same-instance case
// (position-scope-exclusivity design.md; two cycles sharing one instance
// is explicitly not ABI's responsibility to additionally forbid).
test("two different pairs racing the same scope: exactly one is claimed, the other fails closed before any exchange write", async () => {
  await withService(async ({ service, bybit }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);

    const [first, second] = await Promise.all([
      service.apply(makeCommand({ strategyInstanceId: "instance-A", tradeCycleId: "cycle-A1" })),
      service.apply(makeCommand({ strategyInstanceId: "instance-B", tradeCycleId: "cycle-B1" })),
    ]);

    const results = [first, second];
    const succeeded = results.filter((result) => result.statusCode === 200);
    const failed = results.filter((result) => result.statusCode !== 200);

    assert.equal(succeeded.length, 1, "exactly one pair claims the scope");
    assert.equal(failed.length, 1);
    assertInternalError(failed[0]!);
    assert.equal(bybit.createOrderCalls.length, 1, "the losing pair never reaches the exchange");
  });
});

test("two different pairs on different scopes both succeed independently", async () => {
  await withService(async ({ service, bybit }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);

    const [btc, eth] = await Promise.all([
      service.apply(makeCommand({ strategyInstanceId: "instance-A", tradeCycleId: "cycle-A1" })),
      service.apply(
        makeCommand({ strategyInstanceId: "instance-B", tradeCycleId: "cycle-B1", ticker: "ETHUSDT.P" }),
      ),
    ]);

    assertApplied(btc, "0.001");
    assertApplied(eth, "0.001");
    assert.equal(bybit.createOrderCalls.length, 2);
  });
});

test("a durably absent pair releases its scope for a different pair", async () => {
  await withService(async ({ service, bybit }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    await service.apply(makeCommand({ strategyInstanceId: "instance-A", tradeCycleId: "cycle-A1" }));

    bybit.orderByLinkIdResponse = orderList([]);
    bybit.orderHistoryResponse = orderList([]);
    const cancelled = await service.apply(
      makeCommand({ strategyInstanceId: "instance-A", tradeCycleId: "cycle-A1", desiredEntry: null }),
    );
    assertAbsent(cancelled);

    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    const other = await service.apply(makeCommand({ strategyInstanceId: "instance-B", tradeCycleId: "cycle-B1" }));
    assertApplied(other, "0.001");
  });
});

test("a durably terminal-without-fill pair releases its scope for a different pair", async () => {
  await withService(async ({ service, bybit }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    await service.apply(makeCommand({ strategyInstanceId: "instance-A", tradeCycleId: "cycle-A1" }));

    bybit.orderByLinkIdResponse = orderList([]);
    bybit.orderHistoryResponse = orderList([{ orderStatus: "Rejected", cumExecQty: "0" }]);
    const terminal = await service.apply(makeCommand({ strategyInstanceId: "instance-A", tradeCycleId: "cycle-A1" }));
    assertInternalError(terminal);

    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    const other = await service.apply(makeCommand({ strategyInstanceId: "instance-B", tradeCycleId: "cycle-B1" }));
    assertApplied(other, "0.001");
  });
});

test("a crash between the scope claim and the exchange call keeps the scope held, blocking a different pair", async () => {
  await withService(async ({ service, bybit }) => {
    bybit.createOrder = async () => {
      throw new Error("transport failure");
    };

    const failed = await service.apply(makeCommand({ strategyInstanceId: "instance-A", tradeCycleId: "cycle-A1" }));
    assertInternalError(failed);

    const otherPair = await service.apply(
      makeCommand({ strategyInstanceId: "instance-B", tradeCycleId: "cycle-B1" }),
    );
    assertInternalError(otherPair);
    assert.equal(bybit.createOrderCalls.length, 0, "neither pair ever reached a working exchange call yet");

    bybit.createOrder = async (payload) => {
      bybit.createOrderCalls.push(payload);
      return { retCode: 0, result: { orderLinkId: "fake-create" } };
    };
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);

    const ownerRetry = await service.apply(makeCommand({ strategyInstanceId: "instance-A", tradeCycleId: "cycle-A1" }));
    assertApplied(ownerRetry, "0.001");
  });
});

test("liveness: a mix of same-scope and different-scope pairs, each its own strategy instance, completes without deadlock", async () => {
  await withService(async ({ service, bybit }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);

    const requests: Promise<EntryPackageHttpResult>[] = [];
    for (let index = 0; index < 5; index += 1) {
      requests.push(
        service.apply(makeCommand({ strategyInstanceId: `instance-btc-${index}`, tradeCycleId: `cycle-btc-${index}` })),
      );
      requests.push(
        service.apply(
          makeCommand({
            strategyInstanceId: `instance-eth-${index}`,
            tradeCycleId: `cycle-eth-${index}`,
            ticker: "ETHUSDT.P",
          }),
        ),
      );
    }

    const results = await Promise.all(requests);
    assert.equal(results.length, 10);
    assert.equal(bybit.createOrderCalls.length, 2, "exactly one winner per scope (BTCUSDT, ETHUSDT)");
  });
});

test("scope ownership survives restart: a held-status record blocks a different pair after replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abi-scope-restart-held-"));
  try {
    const path = join(dir, "correlation.jsonl");
    const repoBeforeRestart = new EntryPackageCorrelationRepository(path);
    await repoBeforeRestart.save(makeScopeTestRecord({ status: "applied" }));

    const repoAfterRestart = new EntryPackageCorrelationRepository(path);
    const replayResult = await repoAfterRestart.replay();
    assert.deepEqual(replayResult, { ok: true });

    const result = await runServiceAgainstRepository(
      repoAfterRestart,
      makeCommand({ strategyInstanceId: "instance-B", tradeCycleId: "cycle-B1" }),
    );

    assertInternalError(result.httpResult);
    assert.equal(result.bybit.createOrderCalls.length, 0, "the other pair never reaches the exchange after restart");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scope ownership survives restart: a durably closed record frees its scope after replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abi-scope-restart-closed-"));
  try {
    const path = join(dir, "correlation.jsonl");
    const repoBeforeRestart = new EntryPackageCorrelationRepository(path);
    await repoBeforeRestart.save(makeScopeTestRecord({ status: "absent", orderLinkId: null }));

    const repoAfterRestart = new EntryPackageCorrelationRepository(path);
    const replayResult = await repoAfterRestart.replay();
    assert.deepEqual(replayResult, { ok: true });

    const result = await runServiceAgainstRepository(
      repoAfterRestart,
      makeCommand({ strategyInstanceId: "instance-B", tradeCycleId: "cycle-B1" }),
    );

    assertApplied(result.httpResult, "0.001");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// abi-close-execution-v1: terminal_closed joins absent/terminal_unfilled in
// the durably-closed set replay uses to reconstruct scope ownership — a
// different pair can acquire the freed scope after restart exactly as it
// can for an absent record.
test("scope ownership survives restart: a terminal_closed record frees its scope after replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abi-scope-restart-terminal-closed-"));
  try {
    const path = join(dir, "correlation.jsonl");
    const repoBeforeRestart = new EntryPackageCorrelationRepository(path);
    await repoBeforeRestart.save(makeScopeTestRecord({ status: "terminal_closed" }));

    const repoAfterRestart = new EntryPackageCorrelationRepository(path);
    const replayResult = await repoAfterRestart.replay();
    assert.deepEqual(replayResult, { ok: true });

    const result = await runServiceAgainstRepository(
      repoAfterRestart,
      makeCommand({ strategyInstanceId: "instance-B", tradeCycleId: "cycle-B1" }),
    );

    assertApplied(result.httpResult, "0.001");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The pre-restart record belongs to a different pair ("instance-A") than
// the post-restart request each test above issues ("instance-B") —
// matching the real target model (see the comment above the race test).
function makeScopeTestRecord(
  overrides: Partial<{ status: EntryPackageExecutionStatus; orderLinkId: string | null }> = {},
): EntryPackageExecutionRecord {
  const orderLinkId = overrides.orderLinkId === undefined ? "restart-link-1" : overrides.orderLinkId;
  return {
    strategy_instance_id: "instance-A",
    trade_cycle_id: "cycle-A1",
    ticker: "BTCUSDT.P",
    exchange_symbol: "BTCUSDT",
    exchange_category: "linear",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    desired_entry: orderLinkId === null ? null : makeDesiredEntry(),
    risk_multiplier: "1",
    calculated_quantity: orderLinkId === null ? null : "0.001",
    order_link_id: orderLinkId,
    order_id: orderLinkId === null ? null : "restart-order-1",
    generation: 1,
    status: overrides.status ?? "applied",
    early_execution_observation: null,
    binding_history: [],
    pending_action: orderLinkId === null ? null : "create",
    current_binding_started_at: orderLinkId === null ? null : "2026-01-01T00:00:00.000Z",
  };
}

// A terminal_closed record matching makeCommand()'s default pair (unlike
// makeScopeTestRecord's fixed "instance-A"/"cycle-A1", used elsewhere for
// scope tests against a *different* pair's command).
function makeTerminalClosedRecord(): EntryPackageExecutionRecord {
  return {
    strategy_instance_id: "instance-1",
    trade_cycle_id: "cycle-1",
    ticker: "BTCUSDT.P",
    exchange_symbol: "BTCUSDT",
    exchange_category: "linear",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    desired_entry: null,
    risk_multiplier: "1",
    calculated_quantity: "0.001",
    order_link_id: "closed-link-1",
    order_id: "closed-order-1",
    generation: 1,
    status: "terminal_closed",
    early_execution_observation: null,
    binding_history: [],
    pending_action: null,
    current_binding_started_at: null,
  };
}

async function runServiceAgainstRepository(
  repository: EntryPackageCorrelationRepository,
  command: EntryPackageCommand,
): Promise<{ httpResult: EntryPackageHttpResult; bybit: FakeBybitAdapter }> {
  const config = makeTestConfig({
    dryRun: false,
    liveTradingEnabled: true,
    bybitApiKey: "test-key",
    bybitApiSecret: "test-secret",
    bybitEnvironment: "testnet",
  });
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = orderList([liveOrder()]);
  const rulesProvider = new FakeInstrumentTradingRulesProvider();
  const positionSizeCalculator = new FixedMinimumPositionSizeCalculator(rulesProvider);

  const service = new EntryPackageApplicationService({
    config,
    bybit,
    correlationRepository: repository,
    positionSizeCalculator,
    mutex: new KeyedMutex(),
    scopeMutex: new KeyedMutex(),
    exchangeInstrumentResolver: new BybitExchangeInstrumentResolver(),
  });

  const httpResult = await service.apply(command);
  return { httpResult, bybit };
}

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

// Builds a getEntryOrder/getEntryOrderHistory response row from the
// literal payload the service actually sent to Bybit's create/amend
// endpoint (captured off FakeBybitAdapter's own call log), rather than a
// second, independently-typed literal duplicated in the test. category/
// symbol/orderLinkId come from `sent` itself — mapEntryPackageToBybit
// derives the write payload and the getEntryOrder* query payloads from the
// same identity, so they always agree. `overrides` lets a mismatch test
// perturb a single read-back field away from what was truly sent, without
// touching the identity fields the decoder matches against.
function sentOrderResponse(
  sent: {
    category: string;
    symbol: string;
    orderLinkId: string;
    triggerPrice: string;
    qty: string;
    stopLoss?: string;
    takeProfit?: string;
  },
  overrides: Partial<{
    orderStatus: string;
    triggerPrice: string;
    qty: string;
    stopLoss: string;
    takeProfit: string;
  }> = {},
): unknown {
  return {
    retCode: 0,
    result: {
      category: sent.category,
      list: [
        {
          orderStatus: "New",
          symbol: sent.symbol,
          orderLinkId: sent.orderLinkId,
          triggerPrice: sent.triggerPrice,
          qty: sent.qty,
          stopLoss: sent.stopLoss,
          takeProfit: sent.takeProfit,
          ...overrides,
        },
      ],
    },
  };
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
    const scopeMutex = new KeyedMutex();

    const service = new EntryPackageApplicationService({
      config,
      bybit,
      correlationRepository: repo,
      positionSizeCalculator,
      mutex,
      scopeMutex,
      exchangeInstrumentResolver,
    });

    await fn({ service, bybit, repo, rulesProvider });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Wires the real BybitInstrumentTradingRulesProvider (instead of
// FakeInstrumentTradingRulesProvider) so a test can drive service.apply
// purely through bybit.instrumentInfoResponse, exercising the actual
// instruments-info response decoder end to end.
async function withRealRulesProviderService(
  fn: (ctx: { service: EntryPackageApplicationService; bybit: FakeBybitAdapter; repo: EntryPackageCorrelationRepository }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "abi-entry-package-app-service-real-rules-"));
  try {
    const config = makeTestConfig({
      dryRun: false,
      liveTradingEnabled: true,
      bybitApiKey: "test-key",
      bybitApiSecret: "test-secret",
      bybitEnvironment: "testnet",
    });
    const bybit = new FakeBybitAdapter();
    const repo = new EntryPackageCorrelationRepository(join(dir, "correlation.jsonl"));
    const rulesProvider = new BybitInstrumentTradingRulesProvider(bybit, config);
    const positionSizeCalculator = new FixedMinimumPositionSizeCalculator(rulesProvider);
    const mutex = new KeyedMutex();
    const scopeMutex = new KeyedMutex();

    const service = new EntryPackageApplicationService({
      config,
      bybit,
      correlationRepository: repo,
      positionSizeCalculator,
      mutex,
      scopeMutex,
      exchangeInstrumentResolver: new BybitExchangeInstrumentResolver(),
    });

    await fn({ service, bybit, repo });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
