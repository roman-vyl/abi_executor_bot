import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { EntryPackageExecutionRecord } from "./entryPackageExecutionRecord.js";
import { correlationRecordKey } from "./entryPackageExecutionRecord.js";

export type CorrelationReplayResult = { ok: true } | { ok: false; reason: string };

// Durable, ABI-owned, single-writer append-only JSONL store of
// EntryPackageExecutionRecords. Not built on Journal: Journal's public query
// surface is signal-shaped and its lenient corruption handling (skip and
// continue) is wrong for a correctness-critical store, which here must fail
// readiness on any non-final corruption instead (design.md §4).
export class EntryPackageCorrelationRepository {
  private readonly path: string;
  private readonly byCompositeKey = new Map<string, EntryPackageExecutionRecord>();
  private readonly byOrderLinkId = new Map<string, EntryPackageExecutionRecord>();
  private readonly byOrderId = new Map<string, EntryPackageExecutionRecord>();

  // FIFO queue serializing physical appends across all keys, since every
  // write shares one file. This is independent of the per-key business-logic
  // mutex in src/concurrency/keyedMutex.ts (design.md §4).
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async replay(): Promise<CorrelationReplayResult> {
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) {
        return { ok: true };
      }
      return {
        ok: false,
        reason: error instanceof Error ? error.message : "failed to read correlation store",
      };
    }

    const lines = content.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === "") {
        continue;
      }

      let record: EntryPackageExecutionRecord;
      try {
        record = JSON.parse(line) as EntryPackageExecutionRecord;
      } catch {
        const isFinalLine = index === lines.length - 1;
        if (isFinalLine) {
          // Tolerate a truncated tail left by a crash mid-append.
          continue;
        }
        return { ok: false, reason: `corrupt correlation record at line ${index + 1}` };
      }

      this.indexRecord(record);
    }

    return { ok: true };
  }

  get(strategyInstanceId: string, tradeCycleId: string): EntryPackageExecutionRecord | undefined {
    return this.byCompositeKey.get(correlationRecordKey(strategyInstanceId, tradeCycleId));
  }

  findByOrderLinkId(orderLinkId: string): EntryPackageExecutionRecord | undefined {
    return this.byOrderLinkId.get(orderLinkId);
  }

  findByOrderId(orderId: string): EntryPackageExecutionRecord | undefined {
    return this.byOrderId.get(orderId);
  }

  async save(record: EntryPackageExecutionRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;

    const task = this.writeQueue.then(() => this.appendDurable(line));
    // A failed append must not wedge the queue for subsequent, unrelated
    // writes; the caller still observes the failure via `task` below.
    this.writeQueue = task.catch(() => undefined);
    await task;

    this.indexRecord(record);
  }

  private async appendDurable(line: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const handle = await open(this.path, "a");
    try {
      await handle.appendFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private indexRecord(record: EntryPackageExecutionRecord): void {
    this.byCompositeKey.set(correlationRecordKey(record.strategy_instance_id, record.trade_cycle_id), record);

    if (record.order_link_id !== null) {
      this.byOrderLinkId.set(record.order_link_id, record);
    }
    if (record.order_id !== null) {
      this.byOrderId.set(record.order_id, record);
    }

    for (const entry of record.binding_history) {
      this.byOrderLinkId.set(entry.order_link_id, record);
      if (entry.order_id !== null) {
        this.byOrderId.set(entry.order_id, record);
      }
    }
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
