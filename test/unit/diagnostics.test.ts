import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  configureDiagnostics,
  diagnosticsEnabled,
  noteDiagnostic,
  timeBybitRequest,
  withDiagnosticsOperation,
} from "../../src/observability/diagnostics.js";
import { classifyOpenPositionResult, withOperationEvents } from "../../src/observability/events.js";

function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "abi-diagnostics-"));
  return run(dir).finally(() => {
    configureDiagnostics(undefined);
    rmSync(dir, { recursive: true, force: true });
  });
}

function silenceStdio(): () => void {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  return () => {
    process.stdout.write = out;
    process.stderr.write = err;
  };
}

async function readLines(path: string): Promise<Record<string, unknown>[]> {
  // appendFile is fire-and-forget; give queued writes a moment to land.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("diagnostics are off by default and pass results and errors through unchanged", async () => {
  configureDiagnostics(undefined);
  assert.equal(diagnosticsEnabled(), false);

  const value = { position_open: true };
  assert.equal(await withDiagnosticsOperation({}, async () => value, () => ({})), value);
  assert.equal(await timeBybitRequest("GET", "/x", async () => value), value);

  const failure = new Error("boom");
  await assert.rejects(
    withDiagnosticsOperation({}, async () => {
      throw failure;
    }, () => ({})),
    (error) => error === failure,
  );
  noteDiagnostic("ignored when off");
});

test("an empty ABI_DIAGNOSTICS_PATH keeps diagnostics off", () => {
  configureDiagnostics("   ");
  assert.equal(diagnosticsEnabled(), false);
});

test("enabled diagnostics write one operation line with Bybit timings, errors and notes", () =>
  withTempDir(async (dir) => {
    const path = join(dir, "diag.jsonl");
    configureDiagnostics(path);
    const restore = silenceStdio();

    const body = { position_open: true };
    let result;
    try {
      result = await withOperationEvents(
        { operation: "open_position", strategyInstanceId: "inst", tradeCycleId: "cycle" },
        async () => {
          await timeBybitRequest("GET", "/v5/order/realtime", async () => ({ ok: true }));
          await assert.rejects(
            timeBybitRequest("GET", "/v5/position/list", async () => {
              throw new Error("The operation was aborted due to timeout");
            }),
          );
          noteDiagnostic("position query failure", new Error("timeout"));
          return { status: 200, body };
        },
        (httpResult) => classifyOpenPositionResult(httpResult.body),
      );
    } finally {
      restore();
    }
    assert.equal(result.body, body);

    const lines = await readLines(path);
    assert.equal(lines[0]?.event, "diagnostics_started");
    const operation = lines.find((line) => line.event === "operation");
    assert.ok(operation);
    assert.equal(operation.operation, "open_position");
    assert.equal(operation.strategy_instance_id, "inst");
    assert.equal(operation.trade_cycle_id, "cycle");
    assert.equal(operation.outcome, "position_open");
    assert.equal(operation.bybit_request_count, 2);
    assert.deepEqual(operation.notes, ["position query failure: timeout"]);
    const requests = operation.bybit_requests as Record<string, unknown>[];
    assert.equal(requests[0]?.path, "/v5/order/realtime");
    assert.equal(requests[0]?.error_name, undefined);
    assert.equal(requests[1]?.path, "/v5/position/list");
    assert.equal(requests[1]?.error_message, "The operation was aborted due to timeout");
  }));

test("a thrown operation is recorded with its error and rethrown unchanged", () =>
  withTempDir(async (dir) => {
    const path = join(dir, "diag.jsonl");
    configureDiagnostics(path);
    const restore = silenceStdio();

    const failure = new TypeError("fetch failed");
    try {
      await assert.rejects(
        withOperationEvents(
          { operation: "open_position", strategyInstanceId: "inst", tradeCycleId: "cycle" },
          async () => {
            throw failure;
          },
          () => ({ outcome: "internal_error", failed: true }),
        ),
        (error) => error === failure,
      );
    } finally {
      restore();
    }

    const operation = (await readLines(path)).find((line) => line.event === "operation");
    assert.equal(operation?.outcome, "thrown");
    assert.equal(operation?.error_name, "TypeError");
    assert.equal(operation?.error_message, "fetch failed");
  }));

test("an unwritable diagnostics path never affects the operation", () =>
  withTempDir(async (dir) => {
    const path = join(dir, "missing-dir", "diag.jsonl");
    configureDiagnostics(path);

    const value = { position_open: false };
    const result = await withDiagnosticsOperation({}, async () => {
      await timeBybitRequest("GET", "/x", async () => null);
      return value;
    }, () => ({ outcome: "position_closed" }));
    assert.equal(result, value);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(existsSync(path), false);
  }));
