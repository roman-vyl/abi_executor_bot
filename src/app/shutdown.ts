import type { Server } from "node:http";

import type { EventLevel } from "../observability/events.js";
import { emitEvent } from "../observability/events.js";

type ProcessSignal = "SIGTERM" | "SIGINT";

type ProcessLike = {
  once(event: ProcessSignal, listener: () => void): NodeJS.Process;
  exit(code?: number): never;
};

type EmitLike = (level: EventLevel, event: string, fields?: Record<string, unknown>) => void;

export function installShutdownHandlers(input: {
  server: Pick<Server, "close">;
  // Releases resources after the HTTP server has closed (e.g. the exchange
  // facts store); runs before exit on both outcomes.
  onShutdownStarted?: () => void;
  onServerClosed?: () => void | Promise<void>;
  processLike?: ProcessLike;
  emit?: EmitLike;
}): void {
  const processLike = input.processLike ?? process;
  const emit = input.emit ?? emitEvent;
  let shuttingDown = false;

  const shutdown = (signal: ProcessSignal): void => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    emit("info", "shutdown_started", { signal });
    input.onShutdownStarted?.();
    input.server.close((error?: Error) => {
      const fail = (closeError: unknown): never => {
        emit("error", "shutdown_failed", { signal,
          reason: closeError instanceof Error ? closeError.message : String(closeError) });
        return processLike.exit(1);
      };
      const finish = () => {
        if (error) return fail(error);
        emit("info", "shutdown_completed", { signal });
        return processLike.exit(0);
      };
      let cleanup: void | Promise<void>;
      try { cleanup = input.onServerClosed?.(); } catch (closeError) { fail(closeError); return; }
      if (cleanup && typeof cleanup.then === "function") void cleanup.then(finish, fail);
      else finish();
    });
  };

  processLike.once("SIGTERM", () => shutdown("SIGTERM"));
  processLike.once("SIGINT", () => shutdown("SIGINT"));
}
