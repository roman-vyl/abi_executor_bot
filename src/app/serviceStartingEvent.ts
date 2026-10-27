import type { AbiConfig } from "../config/config.js";
import { SCHEMA_VERSION } from "../exchangeFacts/schema.js";
import type { ExchangeFactsStoreState } from "./exchangeFactsStartup.js";

// The service_starting event's fields — deliberately excludes
// bybitApiKey/bybitApiSecret; only a boolean "is a key configured" fact is
// reported, mirroring the pre-existing config dump this event replaces.
export function serviceStartingFields(
  config: AbiConfig,
  exchangeFacts: ExchangeFactsStoreState,
): Record<string, unknown> {
  return {
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
    bybitLinearPositionBindingMode: config.bybitLinearPositionBindingMode,
    positionSizingMode: config.positionSizingMode,
    bybitApiKeyConfigured: config.bybitApiKey !== "",
    // State after the open attempt: disabled, enabled or unavailable.
    exchangeFactsStore: exchangeFacts.status,
    // The only version this build opens; any other leaves the store unavailable.
    ...(exchangeFacts.status === "enabled" ? { exchangeFactsSchemaVersion: SCHEMA_VERSION } : {}),
  };
}
