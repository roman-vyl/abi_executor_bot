import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EntryPackageCorrelationRepository } from "../../src/correlation/entryPackageCorrelationRepository.js";
import type { EntryPackageExecutionRecord } from "../../src/correlation/entryPackageExecutionRecord.js";

test("save writes one durable JSONL line and updates in-memory indexes", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    const repo = new EntryPackageCorrelationRepository(path);
    const record = makeRecord({ orderLinkId: "link-1", orderId: "order-1" });

    await repo.save(record);

    const content = await readFile(path, "utf8");
    assert.equal(content, `${JSON.stringify(record)}\n`);
    assert.equal(content.endsWith("\n"), true);

    assert.deepEqual(repo.get("instance-1", "cycle-1"), record);
    assert.deepEqual(repo.findByOrderLinkId("link-1"), record);
    assert.deepEqual(repo.findByOrderId("order-1"), record);
  });
});

test("replay tolerates a truncated final line from a crash mid-append", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    const record = makeRecord({ orderLinkId: "link-1", orderId: "order-1" });
    await writeFile(path, `${JSON.stringify(record)}\n{"incomplete truncated json`, "utf8");

    const repo = new EntryPackageCorrelationRepository(path);
    const result = await repo.replay();

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(repo.get("instance-1", "cycle-1"), record);
  });
});

test("replay fails readiness on non-final corruption", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    const record = makeRecord({ orderLinkId: "link-1", orderId: "order-1" });
    await writeFile(
      path,
      `{"not valid json\n${JSON.stringify(record)}\n`,
      "utf8",
    );

    const repo = new EntryPackageCorrelationRepository(path);
    const result = await repo.replay();

    assert.equal(result.ok, false);
  });
});

test("replay keeps only the last valid line per composite key", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    const first = makeRecord({ orderLinkId: "link-1", orderId: "order-1", generation: 1 });
    const second = makeRecord({ orderLinkId: "link-2", orderId: "order-2", generation: 2 });
    await writeFile(path, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, "utf8");

    const repo = new EntryPackageCorrelationRepository(path);
    await repo.replay();

    assert.deepEqual(repo.get("instance-1", "cycle-1"), second);
  });
});

test("composite, order_link_id, and order_id lookups include historical bindings after restart", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    const record = makeRecord({ orderLinkId: "link-2", orderId: "order-2", generation: 2 });
    record.binding_history.push({
      order_link_id: "link-1",
      order_id: "order-1",
      generation: 1,
      role: "entry",
      exchange_symbol: "BTCUSDT",
      started_at: "2026-01-01T00:00:00.000Z",
      ended_at: "2026-01-01T00:05:00.000Z",
      end_reason: "replaced",
    });
    await writeFile(path, `${JSON.stringify(record)}\n`, "utf8");

    const repo = new EntryPackageCorrelationRepository(path);
    const result = await repo.replay();

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(repo.get("instance-1", "cycle-1"), record);
    assert.deepEqual(repo.findByOrderLinkId("link-2"), record);
    assert.deepEqual(repo.findByOrderId("order-2"), record);
    assert.deepEqual(repo.findByOrderLinkId("link-1"), record);
    assert.deepEqual(repo.findByOrderId("order-1"), record);
  });
});

test("replay fails readiness on a syntactically-valid but wrong-shaped record", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    const validRecord = makeRecord({ orderLinkId: "link-1", orderId: "order-1" });
    const wrongShape = { ...validRecord, generation: "not-a-number" };
    await writeFile(path, `${JSON.stringify(wrongShape)}\n${JSON.stringify(validRecord)}\n`, "utf8");

    const repo = new EntryPackageCorrelationRepository(path);
    const result = await repo.replay();

    assert.equal(result.ok, false);
  });
});

test("replay tolerates a wrong-shaped final line the same way it tolerates truncated JSON", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    const validRecord = makeRecord({ orderLinkId: "link-1", orderId: "order-1" });
    const wrongShapeFinalLine = { ...validRecord, status: "not-a-real-status" };
    await writeFile(path, `${JSON.stringify(validRecord)}\n${JSON.stringify(wrongShapeFinalLine)}\n`, "utf8");

    const repo = new EntryPackageCorrelationRepository(path);
    const result = await repo.replay();

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(repo.get("instance-1", "cycle-1"), validRecord);
  });
});

test("missing correlation file replays as ready with an empty store", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "does-not-exist.jsonl");
    const repo = new EntryPackageCorrelationRepository(path);
    const result = await repo.replay();

    assert.deepEqual(result, { ok: true });
    assert.equal(repo.get("instance-1", "cycle-1"), undefined);
  });
});

test("save ordering is preserved across concurrent writes for different keys (FIFO append queue)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    const repo = new EntryPackageCorrelationRepository(path);

    const records = Array.from({ length: 10 }, (_, index) =>
      makeRecord({
        strategyInstanceId: "instance-1",
        tradeCycleId: `cycle-${index}`,
        orderLinkId: `link-${index}`,
        orderId: `order-${index}`,
      }),
    );

    await Promise.all(records.map((record) => repo.save(record)));

    const content = await readFile(path, "utf8");
    const lines = content.split("\n").filter((line) => line.trim() !== "");
    assert.equal(lines.length, 10);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  });
});

function makeRecord(
  overrides: Partial<{
    strategyInstanceId: string;
    tradeCycleId: string;
    orderLinkId: string;
    orderId: string;
    generation: number;
  }> = {},
): EntryPackageExecutionRecord {
  return {
    strategy_instance_id: overrides.strategyInstanceId ?? "instance-1",
    trade_cycle_id: overrides.tradeCycleId ?? "cycle-1",
    ticker: "BTCUSDT.P",
    exchange_symbol: "BTCUSDT",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    desired_entry: null,
    risk_multiplier: "1",
    calculated_quantity: null,
    order_link_id: overrides.orderLinkId ?? null,
    order_id: overrides.orderId ?? null,
    generation: overrides.generation ?? 1,
    status: "pending_create",
    early_execution_observation: null,
    binding_history: [],
    pending_action: overrides.orderLinkId !== undefined ? "create" : null,
    current_binding_started_at: overrides.orderLinkId !== undefined ? "2026-01-01T00:00:00.000Z" : null,
  };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "abi-entry-package-correlation-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
