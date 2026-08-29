import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EntryPackageCorrelationRepository } from "../../src/correlation/entryPackageCorrelationRepository.js";
import type {
  EntryPackageExecutionRecord,
  EntryPackageExecutionStatus,
  PositionBindingMode,
} from "../../src/correlation/entryPackageExecutionRecord.js";
import {
  directionalPositionSlot,
  directionalPositionSlotKey,
  instrumentPositionScope,
  instrumentPositionScopeKey,
} from "../../src/domain/positionScope.js";
import { encodeBybitPositionIdx } from "../../src/exchange/bybitOrderMapper.js";

test("instrument and directional-slot identities are collision-safe and structurally distinct", () => {
  const instrument = instrumentPositionScope("linear", "BTC:USDT");
  const longSlot = directionalPositionSlot(instrument, "long");
  const shortSlot = directionalPositionSlot(instrument, "short");

  assert.notEqual(instrumentPositionScopeKey(instrument), directionalPositionSlotKey(longSlot));
  assert.notEqual(directionalPositionSlotKey(longSlot), directionalPositionSlotKey(shortSlot));
  assert.deepEqual(longSlot.instrumentScope, shortSlot.instrumentScope);
  assert.notEqual(
    instrumentPositionScopeKey(instrumentPositionScope("linear", "BTC:USDT")),
    instrumentPositionScopeKey(instrumentPositionScope("linear", "BTC::USDT")),
  );
});

test("the sole Bybit encoder maps one-way/long/short to 0/1/2", () => {
  assert.equal(encodeBybitPositionIdx({ mode: "one_way" }), 0);
  assert.equal(encodeBybitPositionIdx({ mode: "hedge", direction: "long" }), 1);
  assert.equal(encodeBybitPositionIdx({ mode: "hedge", direction: "short" }), 2);
});

test("current repository writes always persist an explicit one-way discriminator", async () => {
  await withRepository(async ({ path, repo }) => {
    await repo.save(makeRecord());

    const durable = JSON.parse((await readFile(path, "utf8")).trim()) as Record<string, unknown>;
    assert.equal(durable.position_binding_mode, "one_way");
    assert.equal(repo.get("instance-1", "cycle-1")?.position_binding_mode, "one_way");
  });
});

test("current repository writes reject an omitted or null binding discriminator", async () => {
  await withRepository(async ({ repo }) => {
    const omitted = withoutBindingMode(makeRecord()) as unknown as EntryPackageExecutionRecord;
    await assert.rejects(repo.save(omitted), /explicit position_binding_mode/);
    await assert.rejects(repo.save({ ...makeRecord(), position_binding_mode: null }), /explicit position_binding_mode/);
  });
});

test("inactive legacy record replays as historical one-way state without rewriting the log", async () => {
  await withRepository(async ({ path, repo }) => {
    const legacy = withoutBindingMode(makeRecord({ status: "terminal_closed", desiredSide: null }));
    const original = `${JSON.stringify(legacy)}\n`;
    await writeFile(path, original, "utf8");

    assert.deepEqual(await repo.replay(), { ok: true });
    assert.equal(repo.get("instance-1", "cycle-1")?.position_binding_mode, null);
    assert.equal(await readFile(path, "utf8"), original);
    assert.deepEqual(repo.findActiveRecordsForInstrumentScope(instrumentPositionScope("linear", "BTCUSDT")), []);
  });
});

test("active discriminator-less legacy state blocks readiness with a drain diagnostic", async () => {
  await withRepository(async ({ path, repo }) => {
    await writeFile(path, `${JSON.stringify(withoutBindingMode(makeRecord()))}\n`, "utf8");

    const result = await repo.replay();

    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /active_legacy_one_way_record_requires_drain/);
    assert.deepEqual(repo.findActiveRecordsForDirectionalSlot(longSlot()), []);
  });
});

test("explicit active one-way state survives restart but aliases no directional slot", async () => {
  await withRepository(async ({ path, repo }) => {
    await writeFile(path, `${JSON.stringify(makeRecord({ bindingMode: "one_way" }))}\n`, "utf8");

    assert.deepEqual(await repo.replay(), { ok: true });
    assert.equal(repo.findActiveRecordsForInstrumentScope(instrumentPositionScope("linear", "BTCUSDT")).length, 1);
    assert.deepEqual(repo.findActiveRecordsForDirectionalSlot(longSlot()), []);
    assert.deepEqual(repo.findActiveRecordsForDirectionalSlot(shortSlot()), []);
  });
});

test("same-side hedge owners share one derived slot and release independently", async () => {
  await withRepository(async ({ repo }) => {
    const a = makeRecord({ bindingMode: "hedge", strategyInstanceId: "instance-A", tradeCycleId: "cycle-A" });
    const b = makeRecord({ bindingMode: "hedge", strategyInstanceId: "instance-B", tradeCycleId: "cycle-B" });
    await repo.save(a);
    await repo.save(b);

    assert.deepEqual(
      repo.findActiveRecordsForDirectionalSlot(longSlot()).map((record) => record.strategy_instance_id).sort(),
      ["instance-A", "instance-B"],
    );

    await repo.save({ ...a, status: "terminal_closed" });
    assert.deepEqual(
      repo.findActiveRecordsForDirectionalSlot(longSlot()).map((record) => record.strategy_instance_id),
      ["instance-B"],
    );
  });
});

test("binding geometry cannot change within one durable generation", async () => {
  await withRepository(async ({ repo }) => {
    const oneWay = makeRecord({ bindingMode: "one_way" });
    await repo.save(oneWay);
    await assert.rejects(
      repo.save({ ...oneWay, position_binding_mode: "hedge" }),
      /position_binding_mode changed within generation/,
    );
  });
});

test("mixed hedge slots are reconstructed separately as structurally valid active state", async () => {
  await withRepository(async ({ path, repo }) => {
    const long = makeRecord({
      bindingMode: "hedge",
      strategyInstanceId: "instance-long",
      tradeCycleId: "cycle-long",
      desiredSide: "long",
    });
    const short = makeRecord({
      bindingMode: "hedge",
      strategyInstanceId: "instance-short",
      tradeCycleId: "cycle-short",
      desiredSide: "short",
    });
    await writeFile(path, `${JSON.stringify(long)}\n${JSON.stringify(short)}\n`, "utf8");

    const result = await repo.replay();

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(repo.findActiveRecordsForDirectionalSlot(longSlot()).map((record) => record.strategy_instance_id), [
      "instance-long",
    ]);
    assert.deepEqual(repo.findActiveRecordsForDirectionalSlot(shortSlot()).map((record) => record.strategy_instance_id), [
      "instance-short",
    ]);
    assert.equal(repo.findActiveRecordsForInstrumentScope(instrumentPositionScope("linear", "BTCUSDT")).length, 2);
  });
});

test("active hedge record without a desired-entry side fails closed", async () => {
  await withRepository(async ({ path, repo }) => {
    await writeFile(
      path,
      `${JSON.stringify(makeRecord({ bindingMode: "hedge", desiredSide: null, status: "applied" }))}\n`,
      "utf8",
    );

    const result = await repo.replay();
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /no usable desired_entry\.side/);
  });
});

test("findAllActiveRecords enumerates latest active bindings and excludes inactive legacy/history", async () => {
  await withRepository(async ({ path, repo }) => {
    const oneWay = makeRecord({ strategyInstanceId: "one-way", tradeCycleId: "one-way-cycle" });
    const hedge = {
      ...makeRecord({
        bindingMode: "hedge",
        strategyInstanceId: "hedge",
        tradeCycleId: "hedge-cycle",
        desiredSide: "short",
      }),
      ticker: "ETHUSDT.P",
      exchange_symbol: "ETHUSDT",
    };
    const inactiveHedge = {
      ...makeRecord({
        bindingMode: "hedge",
        strategyInstanceId: "closed-hedge",
        tradeCycleId: "closed-hedge-cycle",
      }),
      status: "terminal_closed" as const,
    };
    const inactiveLegacy = withoutBindingMode({
      ...makeRecord({ strategyInstanceId: "legacy", tradeCycleId: "legacy-cycle" }),
      status: "absent",
    });
    await writeFile(
      path,
      `${JSON.stringify(oneWay)}\n${JSON.stringify(hedge)}\n${JSON.stringify(inactiveHedge)}\n${JSON.stringify(inactiveLegacy)}\n`,
      "utf8",
    );

    assert.deepEqual(await repo.replay(), { ok: true });
    assert.deepEqual(
      repo.findAllActiveRecords().map((record) => record.strategy_instance_id).sort(),
      ["hedge", "one-way"],
    );
  });
});

test("foundation encoder is not wired into one-way production lifecycle services", async () => {
  const productionFiles = [
    "src/services/entryPackage/entryPackageApplicationService.ts",
    "src/services/openPosition/openPositionResolutionService.ts",
    "src/services/protection/protectionApplicationService.ts",
    "src/services/close/closeApplicationService.ts",
    "src/services/entryCycleRecovery/entryCycleRecoveryResolutionService.ts",
  ];
  for (const path of productionFiles) {
    const source = await readFile(path, "utf8");
    assert.equal(source.includes("encodeBybitPositionIdx"), false, path);
    assert.equal(/positionIdx\s*:\s*[12]\b/.test(source), false, path);
  }
});

function longSlot() {
  return directionalPositionSlot(instrumentPositionScope("linear", "BTCUSDT"), "long");
}

function shortSlot() {
  return directionalPositionSlot(instrumentPositionScope("linear", "BTCUSDT"), "short");
}

function withoutBindingMode(record: EntryPackageExecutionRecord): Record<string, unknown> {
  const legacy = { ...record } as Record<string, unknown>;
  delete legacy.position_binding_mode;
  return legacy;
}

function makeRecord(
  overrides: Partial<{
    bindingMode: PositionBindingMode;
    strategyInstanceId: string;
    tradeCycleId: string;
    desiredSide: "long" | "short" | null;
    status: EntryPackageExecutionStatus;
  }> = {},
): EntryPackageExecutionRecord {
  const desiredSide = overrides.desiredSide === undefined ? "long" : overrides.desiredSide;
  return {
    strategy_instance_id: overrides.strategyInstanceId ?? "instance-1",
    trade_cycle_id: overrides.tradeCycleId ?? "cycle-1",
    ticker: "BTCUSDT.P",
    exchange_symbol: "BTCUSDT",
    exchange_category: "linear",
    position_binding_mode: overrides.bindingMode ?? "one_way",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    desired_entry:
      desiredSide === null
        ? null
        : {
            side: desiredSide,
            source_plan_bar_open_time_ms: 1,
            planned_entry_price: "100000",
            initial_stop_price: "99000",
            initial_take_price: "103000",
            locked_exit_profile: "runner",
          },
    risk_multiplier: "1",
    calculated_quantity: "0.001",
    order_link_id: `entry-${overrides.strategyInstanceId ?? "instance-1"}`,
    order_id: null,
    close_order_link_id: null,
    close_order_id: null,
    first_fill_at_ms: null,
    generation: 1,
    status: overrides.status ?? "applied",
    early_execution_observation: null,
    binding_history: [],
    pending_action: null,
    current_binding_started_at: "2026-01-01T00:00:00.000Z",
  };
}

async function withRepository(
  fn: (context: { path: string; repo: EntryPackageCorrelationRepository }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "abi-physical-slot-foundation-"));
  try {
    const path = join(dir, "correlation.jsonl");
    await fn({ path, repo: new EntryPackageCorrelationRepository(path) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
