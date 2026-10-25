import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { ExchangeFactsStore } from "../../src/exchangeFacts/exchangeFactsStore.js";

const WRITER = fileURLToPath(new URL("../fixtures/exchangeFactsCrashWriter.ts", import.meta.url));
const BATCH_SIZE = 25;
const KILLS = 20;

// Runs the writer until it has acknowledged at least one batch and a random
// extra delay has passed, then kills it with SIGKILL mid-write.
function runAndKill(dbPath: string, firstBatch: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", WRITER, dbPath, String(firstBatch), String(BATCH_SIZE)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const acked: number[] = [];
    let buffered = "";
    let stderr = "";
    let killScheduled = false;

    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const match = /^acked (\d+)$/.exec(line);
        if (match) {
          acked.push(Number(match[1]));
        }
      }
      if (acked.length > 0 && !killScheduled) {
        killScheduled = true;
        setTimeout(() => child.kill("SIGKILL"), Math.floor(Math.random() * 40));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (_code, signal) => {
      if (signal !== "SIGKILL") {
        reject(new Error(`writer exited without SIGKILL: ${stderr}`));
        return;
      }
      resolve(acked);
    });
  });
}

test("a writer killed mid-write leaves an intact database with only whole acknowledged batches", { timeout: 180_000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "abi-exchange-facts-crash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "facts.sqlite3");

  const allAcked: number[] = [];
  let maxSeqBefore = 0;
  let nextBatch = 0;

  for (let kill = 0; kill < KILLS; kill += 1) {
    const acked = await runAndKill(dbPath, nextBatch);
    allAcked.push(...acked);

    const db = new Database(dbPath);
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    const perBatch = db
      .prepare<[], { order_id: string; n: number; min_seq: number }>(
        "SELECT order_id, COUNT(*) AS n, MIN(event_seq) AS min_seq FROM exchange_facts GROUP BY order_id",
      )
      .all();
    const maxSeq = db.prepare<[], { m: number }>("SELECT COALESCE(MAX(event_seq), 0) AS m FROM exchange_facts").get()!.m;
    db.close();

    const counts = new Map(perBatch.map((row) => [row.order_id, row]));
    for (const batch of allAcked) {
      assert.equal(counts.get(`crash-order-${batch}`)?.n, BATCH_SIZE, `acknowledged batch ${batch} is complete`);
    }
    for (const row of perBatch) {
      assert.equal(row.n, BATCH_SIZE, `batch ${row.order_id} is whole, never partial`);
    }
    // Every batch written in this run continues above the previous maximum.
    for (const batch of acked) {
      assert.ok(counts.get(`crash-order-${batch}`)!.min_seq > maxSeqBefore);
    }
    maxSeqBefore = maxSeq;
    nextBatch = Math.max(nextBatch, ...perBatch.map((row) => Number(row.order_id.split("-").at(-1)) + 1));
  }

  // The store itself still opens and continues the sequence.
  const store = ExchangeFactsStore.open({ path: dbPath, bybitEnvironment: "demo", category: "linear" });
  store.writeFacts([
    {
      kind: "execution",
      source: "ws",
      sourceEndpoint: "ws:execution",
      rawJson: JSON.stringify({ symbol: "BTCUSDT", orderId: "after-crash", execId: "after-crash-1" }),
      receivedAtMs: 1,
    },
  ]);
  const last = store.readFactsAfter(maxSeqBefore, 10);
  store.close();
  assert.equal(last.length, 1);
  assert.ok(last[0].eventSeq > maxSeqBefore);
  assert.ok(allAcked.length >= KILLS);
});
