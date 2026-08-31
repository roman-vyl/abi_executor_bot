import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../../src/config/config.js";
import { KeyedMutex } from "../../src/concurrency/keyedMutex.js";
import { assureBindingBeforeAdmission, assureReplayedActiveBindings } from "../../src/app/positionModeAssuranceSeams.js";
import { EntryPackageCorrelationRepository } from "../../src/correlation/entryPackageCorrelationRepository.js";
import {
  positionBindingGeometry,
  resolveRecordPhysicalPositionBinding,
  type EntryPackageExecutionRecord,
} from "../../src/correlation/entryPackageExecutionRecord.js";
import { instrumentPositionScope } from "../../src/domain/positionScope.js";
import { evaluatePositionQueryResponse } from "../../src/exchange/bybitAdapter.js";
import {
  mapBindingAwareMarketCloseOrder,
  mapEntryPackageToBybit,
} from "../../src/exchange/bybitOrderMapper.js";
import { assureBybitPositionMode } from "../../src/exchange/bybitPositionModeAssurance.js";
import { decodeOrderQueryResponse } from "../../src/services/entryPackage/orderQueryResponseDecoder.js";
import { classifyOwnCloseOrderOutcome, confirmEntryPackage } from "../../src/services/entryPackage/packageConfirmation.js";
import { OpenPositionResolutionService } from "../../src/services/openPosition/openPositionResolutionService.js";
import { EntryCycleRecoveryResolutionService } from "../../src/services/entryCycleRecovery/entryCycleRecoveryResolutionService.js";
import { resolveOwnAttachedProtection } from "../../src/services/protection/nativeProtectionAttribution.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";

const scope = instrumentPositionScope("linear", "BTCUSDT");

function positionRow(positionIdx: 0 | 1 | 2, overrides: Record<string, unknown> = {}) {
  return {
    symbol: "BTCUSDT",
    positionIdx,
    side: positionIdx === 2 ? "Sell" : "Buy",
    size: "1",
    avgPrice: "100000",
    openTime: 1785000012345,
    stopLoss: positionIdx === 1 ? "99000" : "101000",
    takeProfit: positionIdx === 1 ? "103000" : "97000",
    ...overrides,
  };
}

function orderResponse(positionIdx: number) {
  return {
    retCode: 0,
    result: {
      category: "linear",
      list: [{
        symbol: "BTCUSDT",
        orderLinkId: "link-1",
        positionIdx,
        orderStatus: "New",
        qty: "1",
        cumExecQty: "0",
      }],
    },
  };
}

test("controlled entry and close mapping encode hedge binding while close side stays independent", () => {
  const config = loadConfig({ BYBIT_ENV: "demo" });
  const common = {
    symbol: "BTCUSDT",
    category: "linear" as const,
    plannedEntryPrice: "100000",
    initialStopPrice: "99000",
    initialTakePrice: "103000",
    qty: "1",
    orderLinkId: "link-1",
  };

  assert.equal(mapEntryPackageToBybit(config, { ...common, side: "long", binding: { mode: "hedge", direction: "long" } }).createEntryOrder.positionIdx, 1);
  assert.equal(mapEntryPackageToBybit(config, { ...common, side: "short", binding: { mode: "hedge", direction: "short" } }).createEntryOrder.positionIdx, 2);
  assert.equal("positionIdx" in mapEntryPackageToBybit(config, { ...common, side: "long", binding: { mode: "one_way" } }).createEntryOrder, false);

  assert.deepEqual(
    { side: mapBindingAwareMarketCloseOrder({ category: "linear", symbol: "BTCUSDT", entrySide: "long", qty: "1", orderLinkId: "close-1", binding: { mode: "hedge", direction: "long" } }).side,
      positionIdx: mapBindingAwareMarketCloseOrder({ category: "linear", symbol: "BTCUSDT", entrySide: "long", qty: "1", orderLinkId: "close-1", binding: { mode: "hedge", direction: "long" } }).positionIdx },
    { side: "Sell", positionIdx: 1 },
  );
  assert.deepEqual(
    { side: mapBindingAwareMarketCloseOrder({ category: "linear", symbol: "BTCUSDT", entrySide: "short", qty: "1", orderLinkId: "close-2", binding: { mode: "hedge", direction: "short" } }).side,
      positionIdx: mapBindingAwareMarketCloseOrder({ category: "linear", symbol: "BTCUSDT", entrySide: "short", qty: "1", orderLinkId: "close-2", binding: { mode: "hedge", direction: "short" } }).positionIdx },
    { side: "Buy", positionIdx: 2 },
  );
});

test("order evidence accepts only the expected one-way or directional binding", () => {
  const identity = { category: "linear", symbol: "BTCUSDT", orderLinkId: "link-1" };
  for (const [binding, acceptedIndex] of [
    [{ mode: "one_way" as const }, 0],
    [{ mode: "hedge" as const, direction: "long" as const }, 1],
    [{ mode: "hedge" as const, direction: "short" as const }, 2],
  ] as const) {
    assert.equal(decodeOrderQueryResponse({ response: orderResponse(acceptedIndex), expected: { ...identity, binding } }).kind, "found");
    for (const rejectedIndex of [0, 1, 2].filter((value) => value !== acceptedIndex)) {
      assert.deepEqual(
        decodeOrderQueryResponse({ response: orderResponse(rejectedIndex), expected: { ...identity, binding } }),
        { kind: "protocol_failure", reason: "invalid_position_idx" },
      );
    }
    assert.deepEqual(
      decodeOrderQueryResponse({ response: orderResponse(Number.NaN), expected: { ...identity, binding } }),
      { kind: "protocol_failure", reason: "invalid_position_idx" },
    );
    const missing = orderResponse(acceptedIndex);
    delete (missing.result.list[0] as Record<string, unknown>).positionIdx;
    assert.deepEqual(
      decodeOrderQueryResponse({ response: missing, expected: { ...identity, binding } }),
      { kind: "protocol_failure", reason: "invalid_position_idx" },
    );
  }
});

test("hedge position decoding returns only the target slot and rejects missing or duplicate target evidence", () => {
  const response = { retCode: 0, result: { category: "linear", list: [positionRow(1), positionRow(2)] } };
  const long = evaluatePositionQueryResponse(response, { ...scope, binding: { mode: "hedge", direction: "long" } });
  assert.equal(long.kind, "position");
  if (long.kind === "position") {
    assert.equal(long.row.side, "Buy");
    assert.equal(long.row.stopLoss, "99000");
    assert.equal(long.row.takeProfit, "103000");
  }
  const short = evaluatePositionQueryResponse(response, { ...scope, binding: { mode: "hedge", direction: "short" } });
  assert.equal(short.kind, "position");
  if (short.kind === "position") assert.equal(short.row.side, "Sell");

  assert.deepEqual(
    evaluatePositionQueryResponse({ retCode: 0, result: { category: "linear", list: [positionRow(2)] } }, { ...scope, binding: { mode: "hedge", direction: "long" } }),
    { kind: "failure", reason: "no_row_returned" },
  );
  assert.deepEqual(
    evaluatePositionQueryResponse({ retCode: 0, result: { category: "linear", list: [positionRow(1), positionRow(1)] } }, { ...scope, binding: { mode: "hedge", direction: "long" } }),
    { kind: "failure", reason: "multiple_rows_returned" },
  );
});

test("captured Bybit Demo flat Hedge Mode fixture proves exactly two canonical flat slots", async () => {
  const fixture = JSON.parse(
    await readFile("test/fixtures/bybit-demo-flat-hedge-position-list.json", "utf8"),
  ) as { response: { body: unknown } };
  const input = { category: "linear", symbol: "ZROUSDT" };

  assert.deepEqual(
    evaluatePositionQueryResponse(fixture.response.body, {
      ...input,
      binding: { mode: "hedge", direction: "long" },
    }),
    { kind: "no_position" },
  );
  assert.deepEqual(
    evaluatePositionQueryResponse(fixture.response.body, {
      ...input,
      binding: { mode: "hedge", direction: "short" },
    }),
    { kind: "no_position" },
  );

  const raw = fixture.response.body as {
    result: { list: Array<Record<string, unknown>> };
  };
  assert.deepEqual(
    raw.result.list.map(({ positionIdx, side, size, avgPrice, openTime, stopLoss, takeProfit }) => ({
      positionIdx,
      side,
      size,
      avgPrice,
      openTime,
      stopLoss,
      takeProfit,
    })),
    [
      { positionIdx: 1, side: "", size: "0", avgPrice: "0", openTime: 0, stopLoss: "", takeProfit: "" },
      { positionIdx: 2, side: "", size: "0", avgPrice: "0", openTime: 0, stopLoss: "", takeProfit: "" },
    ],
  );
});

test("flat Hedge Mode decoding fails closed for every unproven omission or field geometry", () => {
  const flat = (positionIdx: 1 | 2, overrides: Record<string, unknown> = {}) =>
    positionRow(positionIdx, {
      side: "",
      size: "0",
      avgPrice: "0",
      openTime: 0,
      stopLoss: "",
      takeProfit: "",
      ...overrides,
    });
  const input = { ...scope, binding: { mode: "hedge" as const, direction: "long" as const } };

  for (const list of [
    [flat(1)],
    [flat(1), flat(2, { side: "Sell", size: "1", avgPrice: "100000", openTime: 1 })],
    [flat(1), flat(2, { avgPrice: "" })],
    [flat(1), flat(2, { openTime: undefined })],
    [flat(1), flat(2, { stopLoss: undefined })],
    [flat(1), flat(2, { takeProfit: undefined })],
  ]) {
    assert.deepEqual(
      evaluatePositionQueryResponse({ retCode: 0, result: { category: "linear", list } }, input),
      { kind: "failure", reason: "unproven_flat_hedge_shape" },
    );
  }
});

test("read-only position mode assurance is explicit, strict, and production-composable", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.openPositionsResponse = { retCode: 0, result: { category: "linear", list: [positionRow(1, { size: "0", side: "", avgPrice: "0", openTime: 0 }), positionRow(2, { size: "0", side: "", avgPrice: "0", openTime: 0 })] } };
  assert.deepEqual(await assureBybitPositionMode({ bybit, instrumentScope: scope, expected: { mode: "hedge", direction: "long" } }), { kind: "verified" });
  assert.deepEqual(await assureBybitPositionMode({ bybit, instrumentScope: scope, expected: { mode: "one_way" } }), { kind: "mismatch" });
  assert.deepEqual(bybit.getOpenPositionsCalls, [{ category: "linear", symbol: "BTCUSDT" }, { category: "linear", symbol: "BTCUSDT" }]);

  bybit.openPositionsError = new Error("offline");
  assert.deepEqual(await assureBybitPositionMode({ bybit, instrumentScope: scope, expected: { mode: "hedge", direction: "short" } }), { kind: "unavailable" });

  const [configSource, serverSource] = await Promise.all([
    readFile("src/config/config.ts", "utf8"),
    readFile("src/app/server.ts", "utf8"),
  ]);
  assert.equal(configSource.includes("ABI_BYBIT_LINEAR_POSITION_BINDING_MODE"), true);
  assert.equal(configSource.includes("HEDGE_MODE"), false);
  assert.equal(serverSource.includes("assureBybitPositionMode"), false);
});

test("startup and lazy seams verify explicit bindings with production wiring", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.openPositionsResponse = {
    retCode: 0,
    result: { category: "linear", list: [positionRow(1, { size: "0" }), positionRow(2, { size: "0" })] },
  };
  assert.equal(await assureBindingBeforeAdmission({ bybit, instrumentScope: scope, expected: { mode: "hedge", direction: "long" } }), true);
  assert.deepEqual(
    await assureReplayedActiveBindings({ bybit, activeRecords: [makeRecord("hedge", "long"), makeRecord("hedge", "short", "second", "second")] }),
    { ok: true },
  );
  assert.deepEqual(
    await assureReplayedActiveBindings({ bybit, activeRecords: [makeRecord("one_way", "long"), makeRecord("hedge", "long", "second", "second")] }),
    { ok: false },
  );
  const serverSource = await readFile("src/app/server.ts", "utf8");
  assert.equal(serverSource.includes("replayCorrelationStore"), true);
});

test("Runtime-facing OpenAPI contracts remain free of binding geometry and numeric slots", async () => {
  for (const path of [
    "docs/openapi/abi-entry-package-api-v1.json",
    "docs/openapi/abi-open-position-lookup-api-v1.json",
    "docs/openapi/abi-position-management-api-v1.json",
    "docs/openapi/abi-entry-cycle-recovery-api-v1.json",
  ]) {
    const source = await readFile(path, "utf8");
    for (const forbidden of ["positionIdx", "position_binding_mode", "directional_slot", "assurance_policy"]) {
      assert.equal(source.includes(forbidden), false, `${path} leaked ${forbidden}`);
    }
  }
});

test("record resolver and open-position resolution preserve one hedge slot end to end", async () => {
  await withRepository(async (repository) => {
    const record = makeRecord("hedge", "long");
    await repository.save(record);
    const physical = resolveRecordPhysicalPositionBinding(record);
    assert.ok(physical !== undefined);
    assert.deepEqual(positionBindingGeometry(physical), { mode: "hedge", direction: "long" });

    const bybit = new FakeBybitAdapter();
    bybit.openPositionsResponse = {
      retCode: 0,
      result: { category: "linear", list: [positionRow(1), positionRow(2)] },
    };
    const service = new OpenPositionResolutionService({ correlationRepository: repository, bybit, mutex: new KeyedMutex() });
    const result = await service.determine(record);
    assert.equal(result.kind, "open");
    if (result.kind === "open") {
      assert.equal(result.averageEntryPrice, "100000");
      assert.equal(result.confirmedStopLoss, "99000");
      assert.equal(result.confirmedTakeProfit, "103000");
    }
  });
});

test("controlled hedge entry confirmation covers unfilled, partial, full, and lost create response", async () => {
  for (const [status, cumExecQty, expectedKind] of [
    ["New", "0", "pending_confirmed"],
    ["PartiallyFilled", "0.4", "partial_fill"],
    ["Filled", "1", "full_fill"],
  ] as const) {
    const bybit = new FakeBybitAdapter();
    // The create acknowledgement is deliberately absent: confirmation is
    // recovering the exact own identity after a lost response.
    bybit.orderByLinkIdResponse = orderResponseWithStatus(1, status, cumExecQty);
    const outcome = await confirmEntryPackage({
      bybit,
      getEntryOrderPayload: { category: "linear", symbol: "BTCUSDT", orderLinkId: "entry-instance-1", limit: "1" },
      getEntryOrderHistoryPayload: { category: "linear", symbol: "BTCUSDT", orderLinkId: "entry-instance-1", limit: "1" },
      expected: { qty: "1", binding: { mode: "hedge", direction: "long" } },
    });
    assert.equal(outcome.kind, expectedKind);
  }
});

test("exact-parent protection children must also match the expected hedge binding", async () => {
  const bybit = new FakeBybitAdapter();
  const child = (role: "PartialStopLoss" | "PartialTakeProfit", orderId: string, positionIdx: number) => ({
    symbol: "BTCUSDT",
    orderLinkId: "",
    orderId,
    parentOrderLinkId: "link-1",
    stopOrderType: role,
    createType: "CreateByPartialStopLoss",
    orderStatus: "Untriggered",
    triggerPrice: role === "PartialStopLoss" ? "99000" : "103000",
    qty: "1",
    leavesQty: "1",
    positionIdx,
  });
  bybit.activeOrdersResponse = {
    retCode: 0,
    result: { category: "linear", list: [child("PartialStopLoss", "stop-1", 1), child("PartialTakeProfit", "take-1", 1)] },
  };
  bybit.orderHistoryForSymbolResponse = { retCode: 0, result: { category: "linear", list: [] } };

  assert.equal((await resolveOwnAttachedProtection({ bybit, category: "linear", symbol: "BTCUSDT", entryOrderLinkId: "link-1", binding: { mode: "hedge", direction: "long" } })).kind, "attributed");
  assert.deepEqual(
    await resolveOwnAttachedProtection({ bybit, category: "linear", symbol: "BTCUSDT", entryOrderLinkId: "link-1", binding: { mode: "hedge", direction: "short" } }),
    { kind: "ambiguous", reason: "query_failed" },
  );
  bybit.activeOrdersResponse = {
    retCode: 0,
    result: { category: "linear", list: [child("PartialStopLoss", "stop-2", 2), child("PartialTakeProfit", "take-2", 2)] },
  };
  assert.equal((await resolveOwnAttachedProtection({ bybit, category: "linear", symbol: "BTCUSDT", entryOrderLinkId: "link-1", binding: { mode: "hedge", direction: "short" } })).kind, "attributed");
  const missing = child("PartialStopLoss", "stop-3", 1);
  delete (missing as Partial<typeof missing>).positionIdx;
  bybit.activeOrdersResponse = { retCode: 0, result: { category: "linear", list: [missing, child("PartialTakeProfit", "take-3", 1)] } };
  assert.deepEqual(
    await resolveOwnAttachedProtection({ bybit, category: "linear", symbol: "BTCUSDT", entryOrderLinkId: "link-1", binding: { mode: "hedge", direction: "long" } }),
    { kind: "ambiguous", reason: "query_failed" },
  );
});

test("hedge close confirmation rejects a slot mismatch and accepts the durable target slot", async () => {
  const bybit = new FakeBybitAdapter();
  bybit.orderByLinkIdResponse = orderResponseWithStatus(1, "Filled", "1");
  const query = { category: "linear", symbol: "BTCUSDT", orderLinkId: "entry-instance-1", limit: "1" as const };
  assert.deepEqual(await classifyOwnCloseOrderOutcome({ bybit, getCloseOrderPayload: query, getCloseOrderHistoryPayload: query, expectedQty: "1", binding: { mode: "hedge", direction: "long" } }), { kind: "matched" });
  assert.deepEqual(await classifyOwnCloseOrderOutcome({ bybit, getCloseOrderPayload: query, getCloseOrderHistoryPayload: query, expectedQty: "1", binding: { mode: "hedge", direction: "short" } }), { kind: "ambiguous" });
});

test("replay accepts structural hedge slots and rejects one-way/hedge aliasing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abi-hedge-replay-"));
  const path = join(directory, "correlation.jsonl");
  try {
    const long = makeRecord("hedge", "long", "long-owner", "long-cycle");
    const short = makeRecord("hedge", "short", "short-owner", "short-cycle");
    await writeFile(path, `${JSON.stringify(long)}\n${JSON.stringify(short)}\n`, "utf8");
    const mixed = new EntryPackageCorrelationRepository(path);
    const mixedResult = await mixed.replay();
    assert.deepEqual(mixedResult, { ok: true });
    assert.equal(mixed.findActiveRecordsForDirectionalSlot({ instrumentScope: scope, direction: "long" }).length, 1);
    assert.equal(mixed.findActiveRecordsForDirectionalSlot({ instrumentScope: scope, direction: "short" }).length, 1);

    await writeFile(path, `${JSON.stringify(makeRecord("one_way", "long", "one", "one"))}\n${JSON.stringify(makeRecord("hedge", "long", "hedge", "hedge"))}\n`, "utf8");
    const aliased = new EntryPackageCorrelationRepository(path);
    const aliasResult = await aliased.replay();
    assert.equal(aliasResult.ok, false);
    assert.match(aliasResult.ok ? "" : aliasResult.reason, /incompatible_active_position_binding_geometry/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("hedge recovery preserves binding for live entry and matched durable close across restart", async () => {
  await withRepository(async (repository) => {
    const live = {
      ...makeRecord("hedge", "long"),
      early_execution_observation: null,
      first_fill_at_ms: null,
    };
    await repository.save(live);
    const bybit = new FakeBybitAdapter();
    bybit.orderByLinkIdResponse = orderResponseWithStatus(1, "New", "0");
    bybit.openPositionsResponse = {
      retCode: 0,
      result: { category: "linear", list: [positionRow(1, { side: "", size: "0" }), positionRow(2)] },
    };
    const recovery = new EntryCycleRecoveryResolutionService({ correlationRepository: repository, bybit, mutex: new KeyedMutex() });
    const liveResult = await recovery.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });
    assert.equal(liveResult.statusCode, 200);
    assert.equal("recovery_state" in liveResult.body ? liveResult.body.recovery_state : "", "entry_order_live");

    const closing = {
      ...makeRecord("hedge", "long"),
      close_order_link_id: "close-1",
    };
    await repository.save(closing);
    bybit.orderByLinkIdResponseByLinkId.set("entry-instance-1", orderResponseWithStatus(1, "Filled", "1"));
    bybit.orderByLinkIdResponseByLinkId.set("close-1", {
      retCode: 0,
      result: { category: "linear", list: [{ ...orderResponseWithStatus(1, "Filled", "1").result.list[0], orderLinkId: "close-1" }] },
    });
    const closedResult = await recovery.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });
    assert.equal(closedResult.statusCode, 200);
    assert.equal("recovery_state" in closedResult.body ? closedResult.body.recovery_state : "", "terminal_after_fill");
    assert.equal(repository.get("instance-1", "cycle-1")?.status, "terminal_closed");
  });
});

test("hedge restart matrix keeps partial/full/protected exposure and ambiguous close slot-isolated", async () => {
  for (const [status, cumExecQty] of [["PartiallyFilled", "0.4"], ["Filled", "1"]] as const) {
    await withRepository(async (repository) => {
      const record = { ...makeRecord("hedge", "long"), early_execution_observation: null };
      await repository.save(record);
      const bybit = new FakeBybitAdapter();
      bybit.orderByLinkIdResponse = orderResponseWithStatus(1, status, cumExecQty);
      bybit.openPositionsResponse = { retCode: 0, result: { category: "linear", list: [positionRow(1), positionRow(2)] } };
      bybit.activeOrdersResponse = { retCode: 0, result: { category: "linear", list: [] } };
      const recovery = new EntryCycleRecoveryResolutionService({ correlationRepository: repository, bybit, mutex: new KeyedMutex() });
      const result = await recovery.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });
      assert.equal(result.statusCode, 200);
      assert.equal("recovery_state" in result.body ? result.body.recovery_state : "", "position_open");
    });
  }

  await withRepository(async (repository) => {
    const record = { ...makeRecord("hedge", "long"), close_order_link_id: "close-ambiguous" };
    await repository.save(record);
    const bybit = new FakeBybitAdapter();
    bybit.orderByLinkIdResponseByLinkId.set("entry-instance-1", orderResponseWithStatus(1, "Filled", "1"));
    bybit.orderByLinkIdResponseByLinkId.set("close-ambiguous", {
      retCode: 0,
      result: { category: "linear", list: [{ ...orderResponseWithStatus(1, "New", "0").result.list[0], orderLinkId: "close-ambiguous" }] },
    });
    bybit.openPositionsResponse = { retCode: 0, result: { category: "linear", list: [positionRow(1), positionRow(2)] } };
    const recovery = new EntryCycleRecoveryResolutionService({ correlationRepository: repository, bybit, mutex: new KeyedMutex() });
    const result = await recovery.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });
    assert.equal(result.statusCode, 500);
    assert.equal(repository.get("instance-1", "cycle-1")?.status, "applied");
  });
});

test("hedge restart matrix fails closed before/lost create and classifies zero, partial, and terminal close", async () => {
  for (const acceptedAfterLostResponse of [false, true]) {
    await withRepository(async (repository) => {
      const pending = {
        ...makeRecord("hedge", "long"),
        status: "pending_create" as const,
        order_id: null,
        pending_action: "create" as const,
        early_execution_observation: null,
        first_fill_at_ms: null,
      };
      await repository.save(pending);
      const bybit = new FakeBybitAdapter();
      bybit.orderByLinkIdResponse = acceptedAfterLostResponse
        ? orderResponseWithStatus(1, "New", "0")
        : { retCode: 0, result: { category: "linear", list: [] } };
      bybit.orderHistoryResponse = { retCode: 0, result: { category: "linear", list: [] } };
      bybit.openPositionsResponse = { retCode: 0, result: { category: "linear", list: [positionRow(1, { side: "", size: "0" }), positionRow(2)] } };
      const recovery = new EntryCycleRecoveryResolutionService({ correlationRepository: repository, bybit, mutex: new KeyedMutex() });
      const result = await recovery.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });
      assert.equal(result.statusCode, acceptedAfterLostResponse ? 200 : 500);
      if (acceptedAfterLostResponse) {
        assert.equal("recovery_state" in result.body ? result.body.recovery_state : "", "entry_order_live");
      }
      assert.equal(repository.get("instance-1", "cycle-1")?.position_binding_mode, "hedge");
    });
  }

  for (const [closeStatus, closeQty, expectedStatus] of [
    ["Rejected", "0", 200],
    ["Filled", "0.4", 500],
  ] as const) {
    await withRepository(async (repository) => {
      const record = { ...makeRecord("hedge", "long"), close_order_link_id: "close-matrix" };
      await repository.save(record);
      const bybit = new FakeBybitAdapter();
      bybit.orderByLinkIdResponseByLinkId.set("entry-instance-1", orderResponseWithStatus(1, "Filled", "1"));
      const closeResponse = {
        retCode: 0,
        result: { category: "linear", list: [{ ...orderResponseWithStatus(1, closeStatus, closeQty).result.list[0], orderLinkId: "close-matrix" }] },
      };
      bybit.orderByLinkIdResponseByLinkId.set("close-matrix", closeResponse);
      bybit.orderHistoryResponseByLinkId.set("close-matrix", closeResponse);
      bybit.openPositionsResponse = { retCode: 0, result: { category: "linear", list: [positionRow(1), positionRow(2)] } };
      const recovery = new EntryCycleRecoveryResolutionService({ correlationRepository: repository, bybit, mutex: new KeyedMutex() });
      const result = await recovery.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });
      assert.equal(result.statusCode, expectedStatus);
      if (expectedStatus === 200) {
        assert.equal("recovery_state" in result.body ? result.body.recovery_state : "", "position_open");
      }
    });
  }

  await withRepository(async (repository) => {
    const terminal = { ...makeRecord("hedge", "short"), status: "terminal_closed" as const };
    await repository.save(terminal);
    const bybit = new FakeBybitAdapter();
    const recovery = new EntryCycleRecoveryResolutionService({ correlationRepository: repository, bybit, mutex: new KeyedMutex() });
    const result = await recovery.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });
    assert.equal(result.statusCode, 200);
    assert.equal("recovery_state" in result.body ? result.body.recovery_state : "", "terminal_after_fill");
    assert.equal(bybit.getOpenPositionsCalls.length, 0);
  });
});

function makeRecord(
  mode: "one_way" | "hedge",
  side: "long" | "short",
  strategyInstanceId = "instance-1",
  tradeCycleId = "cycle-1",
): EntryPackageExecutionRecord {
  return {
    strategy_instance_id: strategyInstanceId,
    trade_cycle_id: tradeCycleId,
    ticker: "BTCUSDT.P",
    exchange_symbol: "BTCUSDT",
    exchange_category: "linear",
    position_binding_mode: mode,
    created_at: "2026-08-29T00:00:00.000Z",
    updated_at: "2026-08-29T00:00:00.000Z",
    desired_entry: {
      side,
      source_plan_bar_open_time_ms: 1,
      planned_entry_price: "100000",
      initial_stop_price: "99000",
      initial_take_price: "103000",
      locked_exit_profile: "profile",
    },
    risk_multiplier: "1",
    calculated_quantity: "1",
    order_link_id: `entry-${strategyInstanceId}`,
    order_id: "order-1",
    close_order_link_id: null,
    close_order_id: null,
    first_fill_at_ms: 1785000012345,
    generation: 1,
    status: "applied",
    early_execution_observation: {
      order_status: "Filled",
      cumulative_filled_qty: "1",
      remaining_qty: "0",
      avg_execution_price: "100000",
      observed_at: "2026-08-29T00:00:00.000Z",
    },
    binding_history: [],
    pending_action: null,
    current_binding_started_at: "2026-08-29T00:00:00.000Z",
  };
}

function orderResponseWithStatus(positionIdx: number, orderStatus: string, cumExecQty: string) {
  return {
    retCode: 0,
    result: {
      category: "linear",
      list: [{
        symbol: "BTCUSDT",
        orderLinkId: "entry-instance-1",
        positionIdx,
        orderStatus,
        qty: "1",
        cumExecQty,
        avgPrice: cumExecQty === "0" ? "" : "100000",
      }],
    },
  };
}

async function withRepository(run: (repository: EntryPackageCorrelationRepository) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "abi-hedge-lifecycle-"));
  try {
    await run(new EntryPackageCorrelationRepository(join(directory, "correlation.jsonl")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
