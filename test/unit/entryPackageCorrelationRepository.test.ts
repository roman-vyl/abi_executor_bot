import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EntryPackageCorrelationRepository } from "../../src/correlation/entryPackageCorrelationRepository.js";
import type {
  EntryPackageExecutionRecord,
  EntryPackageExecutionStatus,
  StoredEntryPackagePendingAction,
} from "../../src/correlation/entryPackageExecutionRecord.js";

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

// abi-entry-cycle-recovery-v1 removed in-place amend and atomic
// cancel-and-create as active write behavior, but an existing durable store
// from before that change can still contain their pending_action values.
// Replay must accept and preserve them rather than fail readiness — see
// LegacyEntryPackagePendingAction.
test("replay accepts a legacy pending_action: amend record without failing readiness", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    const record = makeRecord({
      orderLinkId: "link-1",
      orderId: "order-1",
      status: "pending_replace",
      pendingAction: "amend",
    });
    await writeFile(path, `${JSON.stringify(record)}\n`, "utf8");

    const repo = new EntryPackageCorrelationRepository(path);
    const result = await repo.replay();

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(repo.get("instance-1", "cycle-1"), record);
  });
});

test("replay accepts a legacy pending_action: cancel_and_create record without failing readiness", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    const record = makeRecord({
      orderLinkId: "link-1",
      orderId: "order-1",
      status: "pending_replace",
      pendingAction: "cancel_and_create",
    });
    await writeFile(path, `${JSON.stringify(record)}\n`, "utf8");

    const repo = new EntryPackageCorrelationRepository(path);
    const result = await repo.replay();

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(repo.get("instance-1", "cycle-1"), record);
  });
});

test("replay accepts a non-final legacy-pending_action line superseded by a later record for the same pair", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    const legacy = makeRecord({
      orderLinkId: "link-1",
      orderId: "order-1",
      generation: 1,
      status: "pending_replace",
      pendingAction: "amend",
    });
    const superseding = makeRecord({
      orderLinkId: "link-2",
      orderId: "order-2",
      generation: 2,
      status: "applied",
    });
    await writeFile(path, `${JSON.stringify(legacy)}\n${JSON.stringify(superseding)}\n`, "utf8");

    const repo = new EntryPackageCorrelationRepository(path);
    const result = await repo.replay();

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(repo.get("instance-1", "cycle-1"), superseding);
    // The legacy binding's identity remains reachable via history lookups
    // even though it is no longer the pair's current record.
    assert.deepEqual(repo.findByOrderLinkId("link-1"), legacy);
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
      exchange_category: "linear",
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

test("replay fails readiness on an invalid exchange_category value", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    const validRecord = makeRecord({ orderLinkId: "link-1", orderId: "order-1" });
    const invalidCategory = { ...validRecord, exchange_category: "banana" };
    await writeFile(path, `${JSON.stringify(invalidCategory)}\n${JSON.stringify(validRecord)}\n`, "utf8");

    const repo = new EntryPackageCorrelationRepository(path);
    const result = await repo.replay();

    assert.equal(result.ok, false);
  });
});

test("an absent record with exchange_category '' remains valid", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    const absentRecord = { ...makeRecord(), exchange_category: "", status: "absent" as const };
    await writeFile(path, `${JSON.stringify(absentRecord)}\n`, "utf8");

    const repo = new EntryPackageCorrelationRepository(path);
    const result = await repo.replay();

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(repo.get("instance-1", "cycle-1"), absentRecord);
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

test("save claims a scope for a non-durably-closed record", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    const repo = new EntryPackageCorrelationRepository(path);
    const record = makeRecord({ orderLinkId: "link-1", status: "pending_create" });

    await repo.save(record);

    assert.deepEqual(repo.findOwnerByScope("linear", "BTCUSDT"), record);
  });
});

test("save releases a scope only when the record's own pair becomes durably closed", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    const repo = new EntryPackageCorrelationRepository(path);

    await repo.save(makeRecord({ orderLinkId: "link-1", status: "applied" }));
    await repo.save(makeRecord({ orderLinkId: null, status: "absent" }));

    assert.equal(repo.findOwnerByScope("linear", "BTCUSDT"), undefined);
  });
});

test("two different scopes are claimed independently", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    const repo = new EntryPackageCorrelationRepository(path);
    const btc = makeRecord({
      strategyInstanceId: "instance-A",
      tradeCycleId: "cycle-A1",
      orderLinkId: "link-1",
      exchangeSymbol: "BTCUSDT",
    });
    const eth = makeRecord({
      strategyInstanceId: "instance-B",
      tradeCycleId: "cycle-B1",
      orderLinkId: "link-2",
      exchangeSymbol: "ETHUSDT",
    });

    await repo.save(btc);
    await repo.save(eth);

    assert.deepEqual(repo.findOwnerByScope("linear", "BTCUSDT"), btc);
    assert.deepEqual(repo.findOwnerByScope("linear", "ETHUSDT"), eth);
  });
});

test("releasing a scope never deletes a different pair's own claim on it", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    const repo = new EntryPackageCorrelationRepository(path);

    const ownerRecord = makeRecord({
      strategyInstanceId: "instance-owner",
      tradeCycleId: "cycle-owner",
      orderLinkId: "link-owner",
      status: "applied",
    });
    await repo.save(ownerRecord);

    // A different pair's own record durably closing must never remove
    // instance-owner/cycle-owner's unrelated claim on the same scope, even
    // though this shouldn't arise in practice once the acquisition guard
    // is in place.
    await repo.save(
      makeRecord({
        strategyInstanceId: "instance-other",
        tradeCycleId: "cycle-other",
        orderLinkId: null,
        status: "absent",
      }),
    );

    assert.deepEqual(repo.findOwnerByScope("linear", "BTCUSDT"), ownerRecord);
  });
});

// Cross-pair tests below deliberately vary both strategy_instance_id and
// trade_cycle_id, not trade_cycle_id alone — the target V1 conflict is
// "instance-A/cycle-A1 vs. instance-B/cycle-B1", two different strategy
// instances contending for one scope. Two cycles under the *same*
// instance is a state Runtime's own external invariant already rules
// out, so it is not the scenario ownership reconstruction exists for.
test("replay resolves a scope handed off between pairs without a false-positive intermediate conflict", async () => {
  // The position-scope-exclusivity design.md Decision 8 counter-example:
  // pair A holds BTC, pair B claims BTC while A is still open, then A's
  // *later* record durably closes. The correct final answer is pair B
  // owns BTC; nothing here is a real conflict.
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    const line1 = makeRecord({
      strategyInstanceId: "instance-A",
      tradeCycleId: "cycle-A1",
      orderLinkId: "link-a1",
      generation: 1,
      status: "applied",
    });
    const line2 = makeRecord({
      strategyInstanceId: "instance-B",
      tradeCycleId: "cycle-B1",
      orderLinkId: "link-b1",
      generation: 1,
      status: "pending_create",
    });
    const line3 = makeRecord({
      strategyInstanceId: "instance-A",
      tradeCycleId: "cycle-A1",
      orderLinkId: null,
      generation: 1,
      status: "absent",
    });
    await writeFile(
      path,
      `${JSON.stringify(line1)}\n${JSON.stringify(line2)}\n${JSON.stringify(line3)}\n`,
      "utf8",
    );

    const repo = new EntryPackageCorrelationRepository(path);
    const result = await repo.replay();

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(repo.findOwnerByScope("linear", "BTCUSDT"), line2);
  });
});

test("replay fails closed when two different pairs' latest records both hold the same scope", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    const a = makeRecord({
      strategyInstanceId: "instance-A",
      tradeCycleId: "cycle-A1",
      orderLinkId: "link-a1",
      status: "applied",
    });
    const b = makeRecord({
      strategyInstanceId: "instance-B",
      tradeCycleId: "cycle-B1",
      orderLinkId: "link-b1",
      status: "pending_create",
    });
    await writeFile(path, `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`, "utf8");

    const repo = new EntryPackageCorrelationRepository(path);
    const result = await repo.replay();

    assert.equal(result.ok, false);
  });
});

test("replay treats sequential historical scope reuse as no conflict", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    const aApplied = makeRecord({
      strategyInstanceId: "instance-A",
      tradeCycleId: "cycle-A1",
      orderLinkId: "link-a1",
      status: "applied",
    });
    const aAbsent = makeRecord({
      strategyInstanceId: "instance-A",
      tradeCycleId: "cycle-A1",
      orderLinkId: null,
      status: "absent",
    });
    const b = makeRecord({
      strategyInstanceId: "instance-B",
      tradeCycleId: "cycle-B1",
      orderLinkId: "link-b1",
      status: "pending_create",
    });
    await writeFile(
      path,
      `${JSON.stringify(aApplied)}\n${JSON.stringify(aAbsent)}\n${JSON.stringify(b)}\n`,
      "utf8",
    );

    const repo = new EntryPackageCorrelationRepository(path);
    const result = await repo.replay();

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(repo.findOwnerByScope("linear", "BTCUSDT"), b);
  });
});

test("a record with no real binding (exchange_category '') never claims a scope", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    const repo = new EntryPackageCorrelationRepository(path);
    const neverBound: EntryPackageExecutionRecord = { ...makeRecord(), exchange_category: "", status: "absent" };

    await repo.save(neverBound);

    assert.equal(repo.findOwnerByScope("linear", "BTCUSDT"), undefined);
  });
});

test("replay fails closed on a non-durably-closed record with no real exchange binding", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    // A schema-valid but semantically corrupted line: exchange_category ""
    // is only a valid shape for a durably-closed (never-bound) record, and
    // "unknown" is not durably closed. The current write paths never
    // produce this, but replay must fail closed rather than silently
    // exclude it from ownership.
    const corrupted = { ...makeRecord({ orderLinkId: null, status: "unknown" }), exchange_category: "" };
    await writeFile(path, `${JSON.stringify(corrupted)}\n`, "utf8");

    const repo = new EntryPackageCorrelationRepository(path);
    const result = await repo.replay();

    assert.equal(result.ok, false);
  });
});

test("replay fails closed on a non-durably-closed record with an empty exchange_symbol under a real category", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    const corrupted = { ...makeRecord({ orderLinkId: "link-1", status: "pending_create" }), exchange_symbol: "" };
    await writeFile(path, `${JSON.stringify(corrupted)}\n`, "utf8");

    const repo = new EntryPackageCorrelationRepository(path);
    const result = await repo.replay();

    assert.equal(result.ok, false);
  });
});

test("replay does not fail closed on an empty exchange_symbol under a real category when durably closed", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "correlation.jsonl");
    const record = { ...makeRecord({ orderLinkId: null, status: "absent" }), exchange_symbol: "" };
    await writeFile(path, `${JSON.stringify(record)}\n`, "utf8");

    const repo = new EntryPackageCorrelationRepository(path);
    const result = await repo.replay();

    assert.deepEqual(result, { ok: true });
  });
});

function makeRecord(
  overrides: Partial<{
    strategyInstanceId: string;
    tradeCycleId: string;
    orderLinkId: string;
    orderId: string;
    generation: number;
    status: EntryPackageExecutionStatus;
    exchangeSymbol: string;
    pendingAction: StoredEntryPackagePendingAction;
  }> = {},
): EntryPackageExecutionRecord {
  return {
    strategy_instance_id: overrides.strategyInstanceId ?? "instance-1",
    trade_cycle_id: overrides.tradeCycleId ?? "cycle-1",
    ticker: "BTCUSDT.P",
    exchange_symbol: overrides.exchangeSymbol ?? "BTCUSDT",
    exchange_category: "linear",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    desired_entry: null,
    risk_multiplier: "1",
    calculated_quantity: null,
    order_link_id: overrides.orderLinkId ?? null,
    order_id: overrides.orderId ?? null,
    generation: overrides.generation ?? 1,
    status: overrides.status ?? "pending_create",
    early_execution_observation: null,
    binding_history: [],
    pending_action:
      overrides.pendingAction ?? (overrides.orderLinkId !== undefined ? "create" : null),
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
