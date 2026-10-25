import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { KeyedMutex } from "../../src/concurrency/keyedMutex.js";
import { EntryPackageCorrelationRepository } from "../../src/correlation/entryPackageCorrelationRepository.js";
import type { EntryPackageExecutionRecord } from "../../src/correlation/entryPackageExecutionRecord.js";
import type { DesiredEntryDto, EntryPackageCommand } from "../../src/domain/entryPackageApi.js";
import { BybitExchangeInstrumentResolver } from "../../src/exchange/exchangeInstrumentResolver.js";
import { RiskPercentPositionSizeCalculator } from "../../src/risk/positionSizeCalculator.js";
import { EntryCycleRecoveryResolutionService } from "../../src/services/entryCycleRecovery/entryCycleRecoveryResolutionService.js";
import { EntryPackageApplicationService } from "../../src/services/entryPackage/entryPackageApplicationService.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";
import { FakeInstrumentTradingRulesProvider } from "../fakes/fakeInstrumentTradingRulesProvider.js";
import { makeTestConfig } from "../fixtures/config.js";

// abi-entry-package-declined-and-risk-sizing-v1: an expected refusal of a
// first APPLY is durably closed as absent and answered entry_package_declined.

type Ctx = {
  service: EntryPackageApplicationService;
  recovery: EntryCycleRecoveryResolutionService;
  bybit: FakeBybitAdapter;
  repo: EntryPackageCorrelationRepository;
  path: string;
};

test("a declined first APPLY is closed as absent, answered declined, and recovers as terminal_without_fill", async () => {
  await withService(async ({ service, recovery, bybit, repo, path }) => {
    bybit.accountInfoResponse = { retCode: 0, result: { marginMode: "ISOLATED_MARGIN" } };
    const stdout = captureStdout();
    let result;
    try {
      result = await service.apply(makeCommand());
    } finally {
      stdout.restore();
    }

    assert.deepEqual(result, {
      statusCode: 200,
      body: {
        strategy_instance_id: "instance-1",
        trade_cycle_id: "cycle-1",
        status: "entry_package_declined",
        decline_reason: "margin_mode_not_supported",
        decline_message: "marginMode ISOLATED_MARGIN",
      },
    });
    assert.equal(bybit.createOrderCalls.length, 0);
    assertClosedBeforeExchange(repo.get("instance-1", "cycle-1"));

    const replayed = new EntryPackageCorrelationRepository(path);
    assert.deepEqual(await replayed.replay(), { ok: true });
    assertClosedBeforeExchange(replayed.get("instance-1", "cycle-1"));

    const events = stdout.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const declined = events.filter((event) => event.event === "entry_package_declined");
    assert.equal(declined.length, 1);
    assert.equal(declined[0].decline_reason, "margin_mode_not_supported");
    assert.equal(events.filter((event) => event.event === "entry_admission_rejected").length, 0);

    const state = await recovery.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });
    assert.equal(state.statusCode, 200);
    assert.equal((state.body as { recovery_state?: string }).recovery_state, "terminal_without_fill");
  });
});

test("insufficient balance for the exchange minimum is declined with the numbers in the message", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.walletBalanceResponse = { retCode: 0, result: { list: [{ totalWalletBalance: "50" }] } };

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, {
      strategy_instance_id: "instance-1",
      trade_cycle_id: "cycle-1",
      status: "entry_package_declined",
      decline_reason: "insufficient_balance_for_minimum_quantity",
      decline_message: "quantity 0 below minOrderQty 0.001 (wallet 50, risk 1%, distance 1000)",
    });
    assert.equal(bybit.createOrderCalls.length, 0);
    assertClosedBeforeExchange(repo.get("instance-1", "cycle-1"));
  });
});

test("risk sizing submits the computed quantity when the entry fits", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.orderByLinkIdResponse = { retCode: 0, result: { list: [liveOrder("0.1")] } };

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    // 10000 * 1% / 1000
    assert.equal((result.body as { calculated_quantity?: string }).calculated_quantity, "0.1");
    assert.equal(bybit.createOrderCalls.length, 1);
    assert.equal(repo.get("instance-1", "cycle-1")?.calculated_quantity, "0.1");
  });
});

test("a declined APPLY whose absent write fails answers internal_error and stays admission_pending", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.accountInfoResponse = { retCode: 0, result: { marginMode: "ISOLATED_MARGIN" } };
    const originalSave = repo.save.bind(repo);
    repo.save = async (record: EntryPackageExecutionRecord) => {
      if (record.status === "absent") {
        throw new Error("disk full");
      }
      return originalSave(record);
    };

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 500);
    assert.equal((result.body as { error: { code: string } }).error.code, "internal_error");
    assert.equal(result.diagnostic?.failure_stage, "quantity_calculation");
    assert.equal(repo.get("instance-1", "cycle-1")?.status, "admission_pending");
    assert.equal(bybit.createOrderCalls.length, 0);
  });
});

test("a read failure in risk sizing is internal_error and closed as absent, not declined", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.getWalletBalance = async () => {
      throw new Error("timeout");
    };

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 500);
    assert.equal(result.diagnostic?.failure_stage, "quantity_calculation");
    assertClosedBeforeExchange(repo.get("instance-1", "cycle-1"));
  });
});

test("a CANCEL after a declined APPLY answers absent", async () => {
  await withService(async ({ service, bybit }) => {
    bybit.accountInfoResponse = { retCode: 0, result: { marginMode: "ISOLATED_MARGIN" } };
    assert.equal((await service.apply(makeCommand())).statusCode, 200);

    const cancel = await service.apply(makeCommand({ desiredEntry: null }));

    assert.equal(cancel.statusCode, 200);
    assert.equal((cancel.body as { status?: string }).status, "entry_package_absent");
    assert.equal(bybit.cancelOrderCalls.length, 0);
  });
});

function assertClosedBeforeExchange(record: EntryPackageExecutionRecord | undefined): void {
  assert.ok(record !== undefined);
  assert.equal(record.status, "absent");
  assert.equal(record.desired_entry, null);
  assert.equal(record.order_link_id, null);
  assert.equal(record.exchange_category, "");
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

function liveOrder(qty: string) {
  return {
    orderStatus: "New",
    triggerPrice: "100000",
    qty,
    stopLoss: "99000",
    takeProfit: "103000",
  };
}

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(...String(chunk).split("\n").filter((line) => line.length > 0));
    return true;
  }) as typeof process.stdout.write;
  return {
    lines,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

async function withService(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "abi-entry-declined-"));
  try {
    const config = makeTestConfig({
      dryRun: false,
      liveTradingEnabled: true,
      bybitApiKey: "test-key",
      bybitApiSecret: "test-secret",
      bybitEnvironment: "testnet",
      positionSizingMode: "risk",
    });
    const bybit = new FakeBybitAdapter();
    bybit.accountInfoResponse = { retCode: 0, result: { marginMode: "REGULAR_MARGIN" } };
    bybit.walletBalanceResponse = { retCode: 0, result: { list: [{ totalWalletBalance: "10000" }] } };
    const path = join(dir, "correlation.jsonl");
    const repo = new EntryPackageCorrelationRepository(path);
    const rulesProvider = new FakeInstrumentTradingRulesProvider();
    const mutex = new KeyedMutex();
    const service = new EntryPackageApplicationService({
      config,
      bybit,
      correlationRepository: repo,
      positionSizeCalculator: new RiskPercentPositionSizeCalculator(rulesProvider, bybit),
      mutex,
      scopeMutex: new KeyedMutex(),
      exchangeInstrumentResolver: new BybitExchangeInstrumentResolver(),
    });
    const recovery = new EntryCycleRecoveryResolutionService({ correlationRepository: repo, bybit, mutex });
    await fn({ service, recovery, bybit, repo, path });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
