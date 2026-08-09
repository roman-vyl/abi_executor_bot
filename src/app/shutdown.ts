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
    input.server.close((error?: Error) => {
      if (error) {
        emit("error", "shutdown_failed", { signal, reason: error.message });
        processLike.exit(1);
      }

      emit("info", "shutdown_completed", { signal });
      processLike.exit(0);
    });
  };

  processLike.once("SIGTERM", () => shutdown("SIGTERM"));
  processLike.once("SIGINT", () => shutdown("SIGINT"));
}
