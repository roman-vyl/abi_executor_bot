import assert from "node:assert/strict";
import test from "node:test";

import type { CorrelationReplayResult } from "../../src/correlation/entryPackageCorrelationRepository.js";
import { replayCorrelationStore } from "../../src/app/lifecycleEvents.js";
import type { CorrelationReplayer } from "../../src/app/lifecycleEvents.js";
import type { EntryPackageExecutionRecord } from "../../src/correlation/entryPackageExecutionRecord.js";
import { FakeBybitAdapter } from "../fakes/fakeBybitAdapter.js";

function captureWrites(stream: NodeJS.WriteStream): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = stream.write.bind(stream);
  stream.write = ((chunk: string): boolean => {
    lines.push(chunk);
    return true;
  }) as typeof stream.write;

  return {
    lines,
    restore: () => {
      stream.write = original;
    },
  };
}

function fakeReadiness(): {
  readiness: { markReady(): void; markNotReady(reason: string): void };
  ready: boolean;
  reason: string | undefined;
} {
  const state = { ready: false, reason: undefined as string | undefined };
  return {
    readiness: {
      markReady(): void {
        state.ready = true;
        state.reason = undefined;
      },
      markNotReady(reason: string): void {
        state.ready = false;
        state.reason = reason;
      },
    },
    get ready(): boolean {
      return state.ready;
    },
    get reason(): string | undefined {
      return state.reason;
    },
  };
}

test("successful replay emits correlation_replay_started -> correlation_replay_succeeded -> readiness_ready and marks ready", async () => {
  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);
  const state = fakeReadiness();
  const repository: CorrelationReplayer = {
    async replay(): Promise<CorrelationReplayResult> {
      return { ok: true };
    },
  };

  try {
    await replayCorrelationStore(repository, state.readiness);
  } finally {
    stdout.restore();
    stderr.restore();
  }

  assert.equal(stderr.lines.length, 0);
  assert.equal(stdout.lines.length, 3);
  const events = stdout.lines.map((line) => (JSON.parse(line) as Record<string, unknown>).event);
  assert.deepEqual(events, ["correlation_replay_started", "correlation_replay_succeeded", "readiness_ready"]);
  assert.equal(state.ready, true);
});

test("failed replay (typed result) emits correlation_replay_started -> correlation_replay_failed -> readiness_failed and marks not ready", async () => {
  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);
  const state = fakeReadiness();
  const repository: CorrelationReplayer = {
    async replay(): Promise<CorrelationReplayResult> {
      return { ok: false, reason: "corrupt line 3" };
    },
  };

  try {
    await replayCorrelationStore(repository, state.readiness);
  } finally {
    stdout.restore();
    stderr.restore();
  }

  assert.equal(stdout.lines.length, 1);
  assert.equal((JSON.parse(stdout.lines[0]) as Record<string, unknown>).event, "correlation_replay_started");
  assert.equal(stderr.lines.length, 2);
  const errorEvents = stderr.lines.map((line) => (JSON.parse(line) as Record<string, unknown>).event);
  assert.deepEqual(errorEvents, ["correlation_replay_failed", "readiness_failed"]);
  assert.equal(state.ready, false);
  assert.equal(state.reason, "corrupt line 3");
});

test("replay() rejecting is also treated as a replay failure", async () => {
  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);
  const state = fakeReadiness();
  const repository: CorrelationReplayer = {
    async replay(): Promise<CorrelationReplayResult> {
      throw new Error("disk exploded");
    },
  };

  try {
    await replayCorrelationStore(repository, state.readiness);
  } finally {
    stdout.restore();
    stderr.restore();
  }

  const errorEvents = stderr.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    errorEvents.map((event) => event.event),
    ["correlation_replay_failed", "readiness_failed"],
  );
  assert.equal(errorEvents[0].reason, "disk exploded");
  assert.equal(state.ready, false);
  assert.equal(state.reason, "disk exploded");
});

test("hedge startup accepts both explicit slots only after matching read-only assurance", async () => {
  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);
  const state = fakeReadiness();
  const bybit = new FakeBybitAdapter();
  bybit.openPositionsResponse = hedgeModeRows();
  const activeRecords = [activeRecord("hedge", "long", "long-owner"), activeRecord("hedge", "short", "short-owner")];

  try {
    await replayCorrelationStore({ replay: async () => ({ ok: true }) }, state.readiness, {
      bybit,
      linearPolicy: "hedge",
      getActiveRecords: () => activeRecords,
    });
  } finally {
    stdout.restore();
    stderr.restore();
  }

  assert.equal(state.ready, true);
  assert.equal(state.reason, undefined);
  assert.equal(bybit.getOpenPositionsCalls.length, 2);
});

test("hedge startup fails closed on policy incompatibility before exchange assurance", async () => {
  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);
  const state = fakeReadiness();
  const bybit = new FakeBybitAdapter();

  try {
    await replayCorrelationStore({ replay: async () => ({ ok: true }) }, state.readiness, {
      bybit,
      linearPolicy: "hedge",
      getActiveRecords: () => [activeRecord("one_way", "long", "owner")],
    });
  } finally {
    stdout.restore();
    stderr.restore();
  }

  assert.equal(state.ready, false);
  assert.match(state.reason ?? "", /active_binding_incompatible_with_configured_policy/);
  assert.equal(bybit.getOpenPositionsCalls.length, 0);
});

test("hedge startup fails closed on unavailable or mismatched mode evidence", async () => {
  for (const response of [
    { retCode: 0, result: { category: "linear", list: [{ symbol: "BTCUSDT", positionIdx: 0 }] } },
    { retCode: 0, result: { category: "linear", list: [] } },
  ]) {
    const stdout = captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);
    const state = fakeReadiness();
    const bybit = new FakeBybitAdapter();
    bybit.openPositionsResponse = response;
    try {
      await replayCorrelationStore({ replay: async () => ({ ok: true }) }, state.readiness, {
        bybit,
        linearPolicy: "hedge",
        getActiveRecords: () => [activeRecord("hedge", "long", "owner")],
      });
    } finally {
      stdout.restore();
      stderr.restore();
    }
    assert.equal(state.ready, false);
    assert.equal(state.reason, "active_binding_position_mode_assurance_failed");
  }
});

test("empty hedge startup and default one-way startup add no exchange assurance call", async () => {
  for (const [linearPolicy, activeRecords] of [
    ["hedge", []],
    ["one_way", [activeRecord("one_way", "long", "owner")]],
  ] as const) {
    const stdout = captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);
    const state = fakeReadiness();
    const bybit = new FakeBybitAdapter();
    try {
      await replayCorrelationStore({ replay: async () => ({ ok: true }) }, state.readiness, {
        bybit,
        linearPolicy,
        getActiveRecords: () => [...activeRecords],
      });
    } finally {
      stdout.restore();
      stderr.restore();
    }
    assert.equal(state.ready, true);
    assert.equal(bybit.getOpenPositionsCalls.length, 0);
  }
});

function hedgeModeRows(): unknown {
  return {
    retCode: 0,
    result: {
      category: "linear",
      list: [
        { symbol: "BTCUSDT", positionIdx: 1 },
        { symbol: "BTCUSDT", positionIdx: 2 },
      ],
    },
  };
}

function activeRecord(
  mode: "one_way" | "hedge",
  side: "long" | "short",
  owner: string,
): EntryPackageExecutionRecord {
  return {
    strategy_instance_id: owner,
    trade_cycle_id: `${owner}-cycle`,
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
    order_link_id: `entry-${owner}`,
    order_id: `order-${owner}`,
    close_order_link_id: null,
    close_order_id: null,
    first_fill_at_ms: null,
    generation: 1,
    status: "applied",
    early_execution_observation: null,
    binding_history: [],
    pending_action: null,
    current_binding_started_at: "2026-08-29T00:00:00.000Z",
  };
}
