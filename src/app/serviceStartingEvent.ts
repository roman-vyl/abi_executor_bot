import type { AbiConfig } from "../config/config.js";

// The service_starting event's fields — deliberately excludes
// bybitApiKey/bybitApiSecret; only a boolean "is a key configured" fact is
// reported, mirroring the pre-existing config dump this event replaces.
export function serviceStartingFields(config: AbiConfig): Record<string, unknown> {
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
    bybitApiKeyConfigured: config.bybitApiKey !== "",
  };
}
