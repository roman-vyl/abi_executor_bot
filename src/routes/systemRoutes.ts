import type { AuthorizationState } from "../authorization/authorizationService.js";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { AbiConfig } from "../config/config.js";
import type { ExchangeFactsStoreState } from "../app/exchangeFactsStartup.js";
import { getLiveExecutionMode } from "../execution/liveGuard.js";
import type { ExchangeLinkerStatus } from "../exchangeFacts/exchangeOrderLinker.js";
import type { ExchangeCompletenessStatus, ExchangeRestStatus } from "../exchangeFacts/exchangeRestReconciler.js";
import type { ExchangeStreamStatus } from "../exchangeStream/exchangeStreamRecorder.js";
import type { BybitConnectionStatus } from "../exchange/bybitConnectionHeartbeat.js";
import { writeJson } from "../app/http.js";

export async function handleSystemRoutes(input: {
  request: IncomingMessage;
  response: ServerResponse;
  config: AbiConfig;
  entryPackageReady: boolean;
  authorizationState?: AuthorizationState;
  localRecoveryReady?: boolean;
  bindingsVerified?: boolean;
  activationReason?: string;
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

  const authorized = input.authorizationState === "AUTHORIZED";
  if (request.method === "GET" && request.url === "/health/live") {
    writeJson(response, 200, { ok: true }); return true;
  }
  if (request.method === "GET" && ["/health", "/health/ready"].includes(request.url ?? "")) {
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
      bybitApiKeyConfigured: authorized,
      authorization: input.authorizationState ?? "LOCKED",
      localRecoveryReady: input.localRecoveryReady ?? false,
      bindingsVerified: input.bindingsVerified ?? false,
      ...(input.activationReason ? { activationReason: input.activationReason } : {}),
      entryPackageReady,
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
    writeJson(response, 200, getLiveExecutionMode(config, authorized));
    return true;
  }

  return false;
}
