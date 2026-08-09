import assert from "node:assert/strict";
import test from "node:test";

import { installShutdownHandlers } from "../../src/app/shutdown.js";

class ExitCalled extends Error {
  readonly code: number | undefined;

  constructor(code: number | undefined) {
    super(`exit:${code}`);
    this.code = code;
  }
}

test("SIGTERM closes the server and exits through the normal shutdown path", () => {
  const signalHandlers = new Map<string, () => void>();
  const closeCalls: Array<(error?: Error) => void> = [];
  const logs: string[] = [];

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
    logger: {
      log(message: string): void {
        logs.push(message);
      },
      error(message: string): void {
        logs.push(message);
      },
    },
  });

  signalHandlers.get("SIGTERM")?.();
  assert.equal(closeCalls.length, 1);

  assert.throws(() => closeCalls[0](), (error: unknown) => error instanceof ExitCalled && error.code === 0);
  assert.deepEqual(logs, ["Received SIGTERM; shutting down Abi HTTP server", "Abi HTTP server closed"]);
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
    logger: {
      log(): void {},
      error(): void {},
    },
  });

  signalHandlers.get("SIGINT")?.();
  signalHandlers.get("SIGTERM")?.();

  assert.equal(closeCount, 1);
});
