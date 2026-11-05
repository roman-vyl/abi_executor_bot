import type { IncomingMessage, ServerResponse } from "node:http";

import type { AbiConfig } from "../config/config.js";
import type { ExchangeFactsStoreState } from "../app/exchangeFactsStartup.js";
import { getLiveExecutionMode } from "../execution/liveGuard.js";
import type { ExchangeLinkerStatus } from "../exchangeFacts/exchangeOrderLinker.js";
import type { ExchangeCompletenessStatus, ExchangeRestStatus } from "../exchangeFacts/exchangeRestReconciler.js";
import type { ExchangeStreamStatus } from "../exchangeStream/exchangeStreamRecorder.js";
import type { BybitConnectionStatus } from "../exchange/bybitConnectionHeartbeat.js";
import { executionIsReady } from "../app/executionAdmission.js";
import { writeJson } from "../app/http.js";

export async function handleSystemRoutes(input: {
  request: IncomingMessage;
  response: ServerResponse;
  config: AbiConfig;
  entryPackageReady: boolean;
  exchangeFacts: ExchangeFactsStoreState;
  exchangeStream: ExchangeStreamStatus;
  exchangeLinker: ExchangeLinkerStatus;
  exchangeRest: ExchangeRestStatus;
  exchangeCompleteness: ExchangeCompletenessStatus;
  bybitConnection?: BybitConnectionStatus;
}): Promise<boolean> {
  const {
    request,
    response,
    config,
    entryPackageReady,
    exchangeFacts,
    exchangeStream,
    exchangeLinker,
    exchangeRest,
    exchangeCompleteness,
    bybitConnection,
  } = input;

  const executionReady = executionIsReady(config, entryPackageReady);
  if (request.method === "GET" && request.url === "/health/live") {
    writeJson(response, 200, { ok: true });
    return true;
  }

  if (request.method === "GET" && (request.url === "/health" || request.url === "/health/ready")) {
    writeJson(response, executionReady ? 200 : 503, {
      ok: executionReady,
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
      entryPackageReady: executionReady,
      // Informational only: the journal state never changes ok or the status.
      exchangeFactsStore: exchangeFacts.status,
      ...(exchangeFacts.status === "unavailable" ? { exchangeFactsStoreReason: exchangeFacts.reason } : {}),
      // Informational only, like exchangeFactsStore.
      exchangeStream,
      exchangeLinker,
      exchangeRest,
      exchangeCompleteness,
      // Informational only: the heartbeat never changes ok or the status.
      ...(bybitConnection !== undefined ? { bybitConnection } : {}),
    });
    return true;
  }

  if (request.method === "GET" && request.url === "/execution/mode") {
    const mode = getLiveExecutionMode(config);
    writeJson(response, 200, {
      ...mode,
      authorizationState: config.authorizationMode === "runtime" ? "LOCKED" : executionReady ? "READY" : "RECOVERING",
      canExecuteLive: mode.canExecuteLive && executionReady,
    });
    return true;
  }

  return false;
}
