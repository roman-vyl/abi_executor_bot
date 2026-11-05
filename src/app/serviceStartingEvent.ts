import type { AbiConfig } from "../config/config.js";
import { SCHEMA_VERSION } from "../exchangeFacts/schema.js";
import type { ExchangeFactsStoreState } from "./exchangeFactsStartup.js";

// The service_starting event's fields — deliberately excludes
// credentials; startup is always LOCKED. Legacy boolean field is retained
// as false until later health reporting reflects authorization.
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
    bybitApiKeyConfigured: false,
    // State after the open attempt: disabled, enabled or unavailable.
    exchangeFactsStore: exchangeFacts.status,
    // The only version this build opens; any other leaves the store unavailable.
    ...(exchangeFacts.status === "enabled" ? { exchangeFactsSchemaVersion: SCHEMA_VERSION } : {}),
  };
}
