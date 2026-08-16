// Cross-service composition regression: a successfully confirmed CANCEL
// (EntryPackageApplicationService, durably persisting status: "absent") must
// remain recoverable via EntryCycleRecoveryResolutionService even when the
// caller never learns the EntryPackageAbsent HTTP result -- e.g. the
// response is lost after ABI already committed the durable write. Before
// the durable-status short-circuit, a later recovery-state query for the
// same pair would fail closed (500) forever, because order_link_id is
// cleared to null on a confirmed absent write and the resolution service's
// exchange-query path requires a non-null order_link_id. See
// isDurablyClosedEntryPackageStatus and its use in
// EntryCycleRecoveryResolutionService.process().
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { KeyedMutex } from "../../src/concurrency/keyedMutex.js";
import { EntryPackageCorrelationRepository } from "../../src/correlation/entryPackageCorrelationRepository.js";
import type { DesiredEntryDto, EntryPackageCommand } from "../../src/domain/entryPackageApi.js";
import { BybitExchangeInstrumentResolver } from "../../src/exchange/exchangeInstrumentResolver.js";
import { FixedMinimumPositionSizeCalculator } from "../../src/risk/positionSizeCalculator.js";
import { EntryCycleRecoveryResolutionService } from "../../src/services/entryCycleRecovery/entryCycleRecoveryResolutionService.js";
import { EntryPackageApplicationService } from "../../src/services/entryPackage/entryPackageApplicationService.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";
import { FakeInstrumentTradingRulesProvider } from "../fakes/fakeInstrumentTradingRulesProvider.js";
import { makeTestConfig } from "../fixtures/config.js";

test("a lost EntryPackageAbsent response after a positively confirmed cancel is still recoverable, without any exchange query", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abi-cancel-recovery-composition-"));
  try {
    const correlationPath = join(dir, "correlation.jsonl");
    const applyBybit = new FakeBybitAdapter();
    const applyRepo = new EntryPackageCorrelationRepository(correlationPath);
    const rulesProvider = new FakeInstrumentTradingRulesProvider();
    const applicationService = new EntryPackageApplicationService({
      config: makeTestConfig({
        dryRun: false,
        liveTradingEnabled: true,
        bybitApiKey: "test-key",
        bybitApiSecret: "test-secret",
        bybitEnvironment: "testnet",
      }),
      bybit: applyBybit,
      correlationRepository: applyRepo,
      positionSizeCalculator: new FixedMinimumPositionSizeCalculator(rulesProvider),
      mutex: new KeyedMutex(),
      scopeMutex: new KeyedMutex(),
      exchangeInstrumentResolver: new BybitExchangeInstrumentResolver(),
    });

    // First APPLY creates a live order.
    applyBybit.orderByLinkIdResponse = orderList([liveOrder()]);
    const createResult = await applicationService.apply(makeCommand());
    assert.equal(createResult.statusCode, 200, JSON.stringify(createResult.body));

    // A CANCEL (desiredEntry: null) is positively confirmed by Bybit and
    // durably persisted as status: "absent", order_link_id: null.
    const original = applyBybit.cancelOrder.bind(applyBybit);
    applyBybit.cancelOrder = async (payload) => {
      const result = await original(payload);
      applyBybit.orderByLinkIdResponse = orderList([]);
      applyBybit.orderHistoryResponse = orderList([]);
      return result;
    };
    const cancelResult = await applicationService.apply(makeCommand({ desiredEntry: null }));
    assert.equal(cancelResult.statusCode, 200, JSON.stringify(cancelResult.body));
    assert.equal((cancelResult.body as { status: string }).status, "entry_package_absent");

    const persisted = applyRepo.get("instance-1", "cycle-1");
    assert.equal(persisted?.status, "absent");
    assert.equal(persisted?.order_link_id, null);

    // `cancelResult` above is deliberately never inspected by anything else
    // below -- simulating the caller (Runtime) losing that HTTP response.
    // A fresh, independent EntryCycleRecoveryResolutionService, pointed at
    // the same durable correlation file and a Bybit fake with no configured
    // responses (any query call would throw), still recovers the fact.
    const recoveryBybit = new FakeBybitAdapter();
    const recoveryRepo = new EntryPackageCorrelationRepository(correlationPath);
    const replayed = await recoveryRepo.replay();
    assert.equal(replayed.ok, true, replayed.ok ? undefined : replayed.reason);
    const recoveryService = new EntryCycleRecoveryResolutionService({
      correlationRepository: recoveryRepo,
      bybit: recoveryBybit,
    });

    const recovered = await recoveryService.resolve({
      strategyInstanceId: "instance-1",
      tradeCycleId: "cycle-1",
    });

    assert.deepEqual(recovered, {
      statusCode: 200,
      body: {
        recovery_state: "terminal_without_fill",
        applied_entry_package: null,
        first_fill_at_ms: null,
        average_entry_price: null,
      },
    });
    assert.equal(recoveryBybit.getOrderByLinkIdCalls.length, 0);
    assert.equal(recoveryBybit.getOrderHistoryCalls.length, 0);
    assert.equal(recoveryBybit.getOpenPositionsCalls.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

function liveOrder(): Record<string, unknown> {
  return {
    orderStatus: "New",
    triggerPrice: "100000",
    qty: "0.001",
    stopLoss: "99000",
    takeProfit: "103000",
  };
}

function orderList(items: unknown[]): unknown {
  return { retCode: 0, result: { list: items } };
}
