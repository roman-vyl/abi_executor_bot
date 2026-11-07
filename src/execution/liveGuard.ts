import type { AbiConfig } from "../config/config.js";

export type LiveExecutionMode = {
  dryRun: boolean;
  liveTradingEnabled: boolean;
  bybitEnvironment: "demo" | "testnet" | "mainnet";
  bybitTestnet: boolean;
  bybitApiKeyConfigured: boolean;
  bybitApiSecretConfigured: boolean;
  canExecuteLive: boolean;
  blockedReasons: string[];
};

export function getLiveExecutionMode(config: AbiConfig, authorized: boolean): LiveExecutionMode {
  const blockedReasons: string[] = [];

  if (config.dryRun) {
    blockedReasons.push("ABI_DRY_RUN must be false");
  }

  if (!config.liveTradingEnabled) {
    blockedReasons.push("ABI_LIVE_TRADING_ENABLED must be true");
  }

  if (!authorized) blockedReasons.push("Bybit authorization is required");

  return {
    dryRun: config.dryRun,
    liveTradingEnabled: config.liveTradingEnabled,
    bybitEnvironment: config.bybitEnvironment,
    bybitTestnet: config.bybitTestnet,
    bybitApiKeyConfigured: authorized,
    bybitApiSecretConfigured: authorized,
    canExecuteLive: blockedReasons.length === 0,
    blockedReasons,
  };
}
