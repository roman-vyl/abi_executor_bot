import type { Server } from "node:http";

type ProcessSignal = "SIGTERM" | "SIGINT";

type ProcessLike = {
  once(event: ProcessSignal, listener: () => void): NodeJS.Process;
  exit(code?: number): never;
};

type LoggerLike = {
  log(message: string): void;
  error(message: string): void;
};

export function installShutdownHandlers(input: {
  server: Pick<Server, "close">;
  processLike?: ProcessLike;
  logger?: LoggerLike;
}): void {
  const processLike = input.processLike ?? process;
  const logger = input.logger ?? console;
  let shuttingDown = false;

  const shutdown = (signal: ProcessSignal): void => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.log(`Received ${signal}; shutting down Abi HTTP server`);
    input.server.close((error?: Error) => {
      if (error) {
        logger.error(`Abi HTTP server shutdown failed: ${error.message}`);
        processLike.exit(1);
      }

      logger.log("Abi HTTP server closed");
      processLike.exit(0);
    });
  };

  processLike.once("SIGTERM", () => shutdown("SIGTERM"));
  processLike.once("SIGINT", () => shutdown("SIGINT"));
}
