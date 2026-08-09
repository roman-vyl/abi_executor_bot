import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyOpenPositionResult,
  classifyStatusResult,
  emitEvent,
  withOperationEvents,
} from "../../src/observability/events.js";

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

test("emitEvent writes a single-line JSON object with the base envelope", () => {
  const capture = captureWrites(process.stdout);
  try {
    emitEvent("info", "service_starting", { foo: "bar" });
  } finally {
    capture.restore();
  }

  assert.equal(capture.lines.length, 1);
  const raw = capture.lines[0];
  assert.equal(raw.endsWith("\n"), true);
  assert.equal(raw.trimEnd().includes("\n"), false, "must be exactly one line");

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(parsed.level, "info");
  assert.equal(parsed.service, "abi_executor_bot");
  assert.equal(parsed.event, "service_starting");
  assert.equal(parsed.foo, "bar");
  assert.equal(typeof parsed.timestamp, "string");
});

test("info and warn events go to stdout, not stderr", () => {
  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);
  try {
    emitEvent("info", "some_info_event");
    emitEvent("warn", "some_warn_event");
  } finally {
    stdout.restore();
    stderr.restore();
  }

  assert.equal(stdout.lines.length, 2);
  assert.equal(stderr.lines.length, 0);
});

test("error events go to stderr, not stdout", () => {
  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);
  try {
    emitEvent("error", "some_error_event");
  } finally {
    stdout.restore();
    stderr.restore();
  }

  assert.equal(stderr.lines.length, 1);
  assert.equal(stdout.lines.length, 0);
  const parsed = JSON.parse(stderr.lines[0]) as Record<string, unknown>;
  assert.equal(parsed.level, "error");
});

test("classifyStatusResult: a status body is completed, never failed", () => {
  const result = classifyStatusResult({ status: "entry_package_applied" });
  assert.deepEqual(result, { outcome: "entry_package_applied", failed: false });
});

test("classifyStatusResult: an internal_error error body is failed", () => {
  const result = classifyStatusResult({ error: { code: "internal_error" } });
  assert.deepEqual(result, { outcome: "internal_error", failed: true });
});

test("classifyStatusResult: a handled business-negative error body stays completed", () => {
  const result = classifyStatusResult({ error: { code: "position_not_open" } });
  assert.deepEqual(result, { outcome: "position_not_open", failed: false });
});

test("classifyOpenPositionResult maps the boolean success body to position_open/position_closed", () => {
  assert.deepEqual(classifyOpenPositionResult({ position_open: true }), {
    outcome: "position_open",
    failed: false,
  });
  assert.deepEqual(classifyOpenPositionResult({ position_open: false }), {
    outcome: "position_closed",
    failed: false,
  });
});

test("withOperationEvents: success emits started then exactly one completed, both info", async () => {
  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);
  try {
    const result = await withOperationEvents(
      { operation: "entry_package", strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" },
      async () => ({ status: "entry_package_applied" as const }),
      classifyStatusResult,
    );
    assert.deepEqual(result, { status: "entry_package_applied" });
  } finally {
    stdout.restore();
    stderr.restore();
  }

  assert.equal(stderr.lines.length, 0);
  assert.equal(stdout.lines.length, 2);
  const started = JSON.parse(stdout.lines[0]) as Record<string, unknown>;
  const completed = JSON.parse(stdout.lines[1]) as Record<string, unknown>;
  assert.equal(started.event, "operation_started");
  assert.equal(started.operation, "entry_package");
  assert.equal(started.strategy_instance_id, "instance-1");
  assert.equal(started.trade_cycle_id, "cycle-1");
  assert.equal(completed.event, "operation_completed");
  assert.equal(completed.level, "info");
  assert.equal(completed.outcome, "entry_package_applied");
  assert.equal(typeof completed.duration_ms, "number");
  assert.equal(completed.strategy_instance_id, "instance-1");
  assert.equal(completed.trade_cycle_id, "cycle-1");
});

test("withOperationEvents: a typed, normally-returned internal_error result is operation_failed at error level", async () => {
  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);
  try {
    await withOperationEvents(
      { operation: "protection", strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" },
      async () => ({ error: { code: "internal_error" } as const }),
      classifyStatusResult,
    );
  } finally {
    stdout.restore();
    stderr.restore();
  }

  assert.equal(stdout.lines.length, 1, "only operation_started goes to stdout");
  assert.equal(stderr.lines.length, 1, "the failed terminal event goes to stderr");
  const failed = JSON.parse(stderr.lines[0]) as Record<string, unknown>;
  assert.equal(failed.event, "operation_failed");
  assert.equal(failed.level, "error");
  assert.equal(failed.outcome, "internal_error");
});

test("withOperationEvents: a handled business-negative typed result stays operation_completed, not failed", async () => {
  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);
  try {
    await withOperationEvents(
      { operation: "protection", strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" },
      async () => ({ error: { code: "position_not_open" } as const }),
      classifyStatusResult,
    );
  } finally {
    stdout.restore();
    stderr.restore();
  }

  assert.equal(stderr.lines.length, 0);
  assert.equal(stdout.lines.length, 2);
  const completed = JSON.parse(stdout.lines[1]) as Record<string, unknown>;
  assert.equal(completed.event, "operation_completed");
  assert.equal(completed.outcome, "position_not_open");
});

test("withOperationEvents: an uncaught thrown exception is operation_failed, error level, and rethrown", async () => {
  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);
  let threw: unknown;
  try {
    await withOperationEvents(
      { operation: "open_position", strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" },
      async () => {
        throw new Error("boom");
      },
      classifyOpenPositionResult,
    );
  } catch (error) {
    threw = error;
  } finally {
    stdout.restore();
    stderr.restore();
  }

  assert.ok(threw instanceof Error && threw.message === "boom", "the original exception is rethrown unchanged");
  assert.equal(stdout.lines.length, 1, "only operation_started goes to stdout");
  assert.equal(stderr.lines.length, 1);
  const failed = JSON.parse(stderr.lines[0]) as Record<string, unknown>;
  assert.equal(failed.event, "operation_failed");
  assert.equal(failed.outcome, "internal_error");
  assert.equal(failed.level, "error");
});

test("withOperationEvents: never emits both operation_completed and operation_failed for one invocation", async () => {
  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);
  try {
    await withOperationEvents(
      { operation: "close_position", strategyInstanceId: "instance-1", tradeCycleId: "cycle-1" },
      async () => ({ status: "trade_cycle_closed" as const }),
      classifyStatusResult,
    );
  } finally {
    stdout.restore();
    stderr.restore();
  }

  const allEvents = [...stdout.lines, ...stderr.lines].map((line) => (JSON.parse(line) as Record<string, unknown>).event);
  const terminalEvents = allEvents.filter((event) => event === "operation_completed" || event === "operation_failed");
  assert.equal(terminalEvents.length, 1);
});
