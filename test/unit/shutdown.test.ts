import assert from "node:assert/strict";
import test from "node:test";

import { installShutdownHandlers } from "../../src/app/shutdown.js";
import type { EventLevel } from "../../src/observability/events.js";

class ExitCalled extends Error {
  readonly code: number | undefined;

  constructor(code: number | undefined) {
    super(`exit:${code}`);
    this.code = code;
  }
}

type EmittedEvent = { level: EventLevel; event: string; fields?: Record<string, unknown> };

test("SIGTERM closes the server and exits through the normal shutdown path", () => {
  const signalHandlers = new Map<string, () => void>();
  const closeCalls: Array<(error?: Error) => void> = [];
  const emitted: EmittedEvent[] = [];

  installShutdownHandlers({
    server: {
      close(callback): void {
        closeCalls.push(callback);
      },
    },
    processLike: {
      once(event, listener) {
        signalHandlers.set(event, listener);
        return process;
      },
      exit(code?: number): never {
        throw new ExitCalled(code);
      },
    },
    emit(level, event, fields): void {
      emitted.push({ level, event, fields });
    },
  });

  signalHandlers.get("SIGTERM")?.();
  assert.equal(closeCalls.length, 1);

  assert.throws(() => closeCalls[0](), (error: unknown) => error instanceof ExitCalled && error.code === 0);
  assert.deepEqual(
    emitted.map((entry) => ({ level: entry.level, event: entry.event })),
    [
      { level: "info", event: "shutdown_started" },
      { level: "info", event: "shutdown_completed" },
    ],
  );
  assert.equal(emitted[0].fields?.signal, "SIGTERM");
  assert.equal(emitted[1].fields?.signal, "SIGTERM");
});

test("a close() error emits shutdown_failed at error level and exits 1", () => {
  const signalHandlers = new Map<string, () => void>();
  const closeCalls: Array<(error?: Error) => void> = [];
  const emitted: EmittedEvent[] = [];

  installShutdownHandlers({
    server: {
      close(callback): void {
        closeCalls.push(callback);
      },
    },
    processLike: {
      once(event, listener) {
        signalHandlers.set(event, listener);
        return process;
      },
      exit(code?: number): never {
        throw new ExitCalled(code);
      },
    },
    emit(level, event, fields): void {
      emitted.push({ level, event, fields });
    },
  });

  signalHandlers.get("SIGINT")?.();
  assert.equal(closeCalls.length, 1);

  assert.throws(
    () => closeCalls[0](new Error("boom")),
    (error: unknown) => error instanceof ExitCalled && error.code === 1,
  );
  assert.deepEqual(
    emitted.map((entry) => ({ level: entry.level, event: entry.event })),
    [
      { level: "info", event: "shutdown_started" },
      { level: "error", event: "shutdown_failed" },
    ],
  );
  assert.equal(emitted[1].fields?.reason, "boom");
});

test("repeated termination signals do not close the server twice", () => {
  const signalHandlers = new Map<string, () => void>();
  let closeCount = 0;

  installShutdownHandlers({
    server: {
      close(): void {
        closeCount += 1;
      },
    },
    processLike: {
      once(event, listener) {
        signalHandlers.set(event, listener);
        return process;
      },
      exit(): never {
        throw new ExitCalled(0);
      },
    },
    emit(): void {},
  });

  signalHandlers.get("SIGINT")?.();
  signalHandlers.get("SIGTERM")?.();

  assert.equal(closeCount, 1);
});
