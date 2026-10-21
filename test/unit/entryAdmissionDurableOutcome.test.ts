import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { replayCorrelationStore } from "../../src/app/lifecycleEvents.js";
import { KeyedMutex } from "../../src/concurrency/keyedMutex.js";
import { EntryPackageCorrelationRepository } from "../../src/correlation/entryPackageCorrelationRepository.js";
import type { EntryPackageExecutionRecord } from "../../src/correlation/entryPackageExecutionRecord.js";
import type { DesiredEntryDto, EntryPackageCommand, EntryPackageHttpResult } from "../../src/domain/entryPackageApi.js";
import { describeErrorCause } from "../../src/domain/entryPackageApi.js";
import { BybitExchangeInstrumentResolver } from "../../src/exchange/exchangeInstrumentResolver.js";
import type { ExchangeInstrumentResolver } from "../../src/exchange/exchangeInstrumentResolver.js";
import { FixedMinimumPositionSizeCalculator } from "../../src/risk/positionSizeCalculator.js";
import { EntryCycleRecoveryResolutionService } from "../../src/services/entryCycleRecovery/entryCycleRecoveryResolutionService.js";
import { EntryPackageApplicationService } from "../../src/services/entryPackage/entryPackageApplicationService.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";
import { FakeInstrumentTradingRulesProvider } from "../fakes/fakeInstrumentTradingRulesProvider.js";
import { makeTestConfig } from "../fixtures/config.js";

// abi-entry-admission-durable-outcome-v1: every PUT that reaches the
// application service leaves a durable trace for its pair, and a failure
// before the provisional pending_create write is closed as absent.

type Ctx = {
  service: EntryPackageApplicationService;
  recovery: EntryCycleRecoveryResolutionService;
  bybit: FakeBybitAdapter;
  repo: EntryPackageCorrelationRepository;
  rulesProvider: FakeInstrumentTradingRulesProvider;
  path: string;
};

test("quantity failure writes the admission intent first, then closes it as absent with no exchange call", async () => {
  await withService(async ({ service, recovery, bybit, repo, rulesProvider, path }) => {
    const statusesSeenByRules: (string | undefined)[] = [];
    rulesProvider.getRules = async () => {
      statusesSeenByRules.push(repo.get("instance-1", "cycle-1")?.status);
      throw new Error("instruments-info unavailable");
    };

    const result = await service.apply(makeCommand());

    assertInternalError(result);
    assert.deepEqual(result.diagnostic, {
      failure_stage: "quantity_calculation",
      error_cause: "Error: instruments-info unavailable",
    });
    assert.deepEqual(statusesSeenByRules, ["admission_pending"]);
    assert.equal(bybit.createOrderCalls.length, 0);
    assertClosedBeforeExchange(repo.get("instance-1", "cycle-1"));

    const replayed = new EntryPackageCorrelationRepository(path);
    assert.deepEqual(await replayed.replay(), { ok: true });
    assertClosedBeforeExchange(replayed.get("instance-1", "cycle-1"));

    const state = await recovery.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });
    assert.equal(state.statusCode, 200);
    assert.equal((state.body as { recovery_state?: string }).recovery_state, "terminal_without_fill");
    assert.equal(bybit.getOrderByLinkIdCalls.length, 0);
  });
});

test("an instrument-resolution exception before the boundary is closed as absent", async () => {
  const throwingResolver: ExchangeInstrumentResolver = {
    resolve() {
      throw new Error("unsupported ticker");
    },
  } as unknown as ExchangeInstrumentResolver;

  await withService(async ({ service, bybit, repo }) => {
    const result = await service.apply(makeCommand());

    assertInternalError(result);
    assert.equal(result.diagnostic?.failure_stage, "instrument_resolution");
    assert.equal(bybit.createOrderCalls.length, 0);
    assertClosedBeforeExchange(repo.get("instance-1", "cycle-1"));
  }, throwingResolver);
});

test("a scope conflict is closed as absent and named scope_admission", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);
    assert.equal(
      (await service.apply(makeCommand({ strategyInstanceId: "instance-A", tradeCycleId: "cycle-A1" }))).statusCode,
      200,
    );
    const callsBefore = bybit.createOrderCalls.length;

    const result = await service.apply(
      makeCommand({
        strategyInstanceId: "instance-B",
        tradeCycleId: "cycle-B1",
        desiredEntry: makeDesiredEntry({ side: "short" }),
      }),
    );

    assertInternalError(result);
    assert.deepEqual(result.diagnostic, { failure_stage: "scope_admission", error_cause: "scope_conflict" });
    assert.equal(bybit.createOrderCalls.length, callsBefore);
    assertClosedBeforeExchange(repo.get("instance-B", "cycle-B1"));
  });
});

test("an exchange exception after the boundary keeps the existing unknown status and is never closed as absent", async () => {
  await withService(async ({ service, bybit, repo }) => {
    bybit.createOrder = async (payload) => {
      bybit.createOrderCalls.push(payload);
      throw new Error("socket hang up");
    };

    const result = await service.apply(makeCommand());

    assertInternalError(result);
    assert.equal(result.diagnostic?.failure_stage, "exchange_create");
    const record = repo.get("instance-1", "cycle-1");
    assert.equal(record?.status, "unknown");
    assert.equal(record?.pending_action, "create");
  });
});

test("a failed provisional write is never closed as absent: the record stays admission_pending and recovery fails safe", async () => {
  await withService(async ({ service, recovery, bybit, repo }) => {
    const originalSave = repo.save.bind(repo);
    repo.save = async (record: EntryPackageExecutionRecord) => {
      if (record.status === "pending_create") {
        throw new Error("disk full");
      }
      return originalSave(record);
    };

    const result = await service.apply(makeCommand());

    assertInternalError(result);
    assert.equal(result.diagnostic?.failure_stage, "provisional_write");
    assert.equal(bybit.createOrderCalls.length, 0);
    assert.equal(repo.get("instance-1", "cycle-1")?.status, "admission_pending");

    const state = await recovery.resolve({ strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" });
    assert.equal(state.statusCode, 500);
    assert.equal(bybit.getOrderByLinkIdCalls.length, 0);
  });
});

test("a failed absent write leaves admission_pending; a later CANCEL closes it as absent", async () => {
  await withService(async ({ service, bybit, repo, rulesProvider }) => {
    rulesProvider.failure = new Error("instruments-info unavailable");
    const originalSave = repo.save.bind(repo);
    let failAbsent = true;
    repo.save = async (record: EntryPackageExecutionRecord) => {
      if (failAbsent && record.status === "absent") {
        throw new Error("disk full");
      }
      return originalSave(record);
    };

    assertInternalError(await service.apply(makeCommand()));
    assert.equal(repo.get("instance-1", "cycle-1")?.status, "admission_pending");

    failAbsent = false;
    const cancel = await service.apply(makeCommand({ desiredEntry: null }));
    assert.equal(cancel.statusCode, 200);
    assert.equal((cancel.body as { status?: string }).status, "entry_package_absent");
    assertClosedBeforeExchange(repo.get("instance-1", "cycle-1"));
    assert.equal(bybit.createOrderCalls.length, 0);
    assert.equal(bybit.cancelOrderCalls.length, 0);
  });
});

test("a repeat PUT on a leftover admission intent is admitted again and applied normally", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(admissionRecord("instance-1", "cycle-1"));
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);

    const result = await service.apply(makeCommand());

    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.equal(repo.get("instance-1", "cycle-1")?.status, "applied");
    assert.equal(bybit.createOrderCalls.length, 1);
  });
});

test("an admission intent never claims or blocks a physical position scope", async () => {
  await withService(async ({ service, bybit, repo }) => {
    await repo.save(admissionRecord("instance-A", "cycle-A1"));
    bybit.orderByLinkIdResponse = orderList([liveOrder()]);

    const result = await service.apply(
      makeCommand({ strategyInstanceId: "instance-B", tradeCycleId: "cycle-B1" }),
    );

    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.equal(bybit.createOrderCalls.length, 1);
  });
});

test("startup closes a leftover admission intent as absent before readiness and emits one event", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abi-admission-startup-"));
  try {
    const path = join(dir, "correlation.jsonl");
    const writer = new EntryPackageCorrelationRepository(path);
    await writer.save(admissionRecord("instance-1", "cycle-1"));

    const repo = new EntryPackageCorrelationRepository(path);
    let ready = false;
    const stdout = captureStdout();
    try {
      await replayCorrelationStore(repo, {
        markReady: () => {
          ready = true;
        },
        markNotReady: () => {
          ready = false;
        },
      });
    } finally {
      stdout.restore();
    }

    assert.equal(ready, true);
    assertClosedBeforeExchange(repo.get("instance-1", "cycle-1"));
    const rejected = stdout.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.event === "entry_admission_rejected");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].failure_stage, "startup_recovery");
    assert.equal(rejected[0].trade_cycle_id, "cycle-1");

    const again = new EntryPackageCorrelationRepository(path);
    assert.deepEqual(await again.replay(), { ok: true });
    assertClosedBeforeExchange(again.get("instance-1", "cycle-1"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a pre-exchange rejection emits entry_admission_rejected with its stage", async () => {
  await withService(async ({ service, rulesProvider }) => {
    rulesProvider.failure = new Error("instruments-info unavailable");
    const stdout = captureStdout();
    try {
      assertInternalError(await service.apply(makeCommand()));
    } finally {
      stdout.restore();
    }
    const rejected = stdout.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.event === "entry_admission_rejected");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].failure_stage, "quantity_calculation");
  });
});

test("describeErrorCause drops exchange payloads and response bodies", () => {
  assert.equal(
    describeErrorCause(new Error('Bybit HTTP 403: {"retCode":10003,"apiKey":"secret"}')),
    "Error: Bybit HTTP 403: [payload omitted]",
  );
  assert.equal(
    describeErrorCause(new Error("Bybit returned non-JSON response with HTTP 502: <html>gateway</html>")),
    "Error: Bybit returned non-JSON response with HTTP 502",
  );
  assert.equal(describeErrorCause(new Error("Bybit retCode 110007: ab not enough")), "Error: Bybit retCode 110007: ab not enough");
  assert.equal(describeErrorCause("text"), "non-error thrown: string");
  assert.ok(describeErrorCause(new Error("x".repeat(1000))).length <= 300);
});

function admissionRecord(strategyInstanceId: string, tradeCycleId: string): EntryPackageExecutionRecord {
  return {
    strategy_instance_id: strategyInstanceId,
    trade_cycle_id: tradeCycleId,
    ticker: "BTCUSDT.P",
    exchange_symbol: "",
    exchange_category: "",
    position_binding_mode: "one_way",
    created_at: "2026-10-21T10:05:24.760Z",
    updated_at: "2026-10-21T10:05:24.760Z",
    desired_entry: makeDesiredEntry({ side: "short" }),
    risk_multiplier: "1",
    calculated_quantity: null,
    order_link_id: null,
    order_id: null,
    close_order_link_id: null,
    close_order_id: null,
    closure_reason: null,
    closure_order_id: null,
    closure_order_link_id: null,
    closure_parent_order_link_id: null,
    first_fill_at_ms: null,
    generation: 0,
    status: "admission_pending",
    early_execution_observation: null,
    binding_history: [],
    pending_action: null,
    current_binding_started_at: null,
  };
}

function assertClosedBeforeExchange(record: EntryPackageExecutionRecord | undefined): void {
  assert.ok(record !== undefined);
  assert.equal(record.status, "absent");
  assert.equal(record.desired_entry, null);
  assert.equal(record.order_link_id, null);
  assert.equal(record.exchange_category, "");
}

function assertInternalError(result: EntryPackageHttpResult): void {
  assert.equal(result.statusCode, 500, JSON.stringify(result.body));
  assert.equal((result.body as { error: { code: string } }).error.code, "internal_error");
  assert.equal("diagnostic" in result.body, false);
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

function liveOrder() {
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

async function withService(
  fn: (ctx: Ctx) => Promise<void>,
  exchangeInstrumentResolver: ExchangeInstrumentResolver = new BybitExchangeInstrumentResolver(),
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "abi-entry-admission-"));
  try {
    const config = makeTestConfig({
      dryRun: false,
      liveTradingEnabled: true,
      bybitApiKey: "test-key",
      bybitApiSecret: "test-secret",
      bybitEnvironment: "testnet",
    });
    const bybit = new FakeBybitAdapter();
    const path = join(dir, "correlation.jsonl");
    const repo = new EntryPackageCorrelationRepository(path);
    const rulesProvider = new FakeInstrumentTradingRulesProvider();
    const mutex = new KeyedMutex();
    const service = new EntryPackageApplicationService({
      config,
      bybit,
      correlationRepository: repo,
      positionSizeCalculator: new FixedMinimumPositionSizeCalculator(rulesProvider),
      mutex,
      scopeMutex: new KeyedMutex(),
      exchangeInstrumentResolver,
    });
    const recovery = new EntryCycleRecoveryResolutionService({ correlationRepository: repo, bybit, mutex });
    await fn({ service, recovery, bybit, repo, rulesProvider, path });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
