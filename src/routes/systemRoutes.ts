import type { IncomingMessage, ServerResponse } from "node:http";

import type { AbiConfig } from "../config/config.js";
import { getLiveExecutionMode } from "../execution/liveGuard.js";
import { writeJson } from "../app/http.js";

export async function handleSystemRoutes(input: {
  request: IncomingMessage;
  response: ServerResponse;
  config: AbiConfig;
  entryPackageReady: boolean;
}): Promise<boolean> {
  const { request, response, config, entryPackageReady } = input;

  if (request.method === "GET" && request.url === "/health") {
    writeJson(response, entryPackageReady ? 200 : 503, {
      ok: entryPackageReady,
      host: config.host,
      port: config.port,
      dryRun: config.dryRun,
      liveTradingEnabled: config.liveTradingEnabled,
      bybitEnvironment: config.bybitEnvironment,
      bybitTestnet: config.bybitTestnet,
      bybitAccountType: config.bybitAccountType,
      bybitRecvWindow: config.bybitRecvWindow,
      bybitCategory: config.bybitCategory,
      bybitSettleCoin: config.bybitSettleCoin,
      bybitTriggerBy: config.bybitTriggerBy,
      bybitApiKeyConfigured: config.bybitApiKey !== "",
      entryPackageReady,
    });
    return true;
  }

  if (request.method === "GET" && request.url === "/execution/mode") {
    writeJson(response, 200, getLiveExecutionMode(config));
    return true;
  }

  return false;
}
