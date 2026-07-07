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

export function getLiveExecutionMode(config: AbiConfig): LiveExecutionMode {
  const blockedReasons: string[] = [];

  if (config.dryRun) {
    blockedReasons.push("ABI_DRY_RUN must be false");
  }

  if (!config.liveTradingEnabled) {
    blockedReasons.push("ABI_LIVE_TRADING_ENABLED must be true");
  }

  if (config.bybitApiKey === "") {
    blockedReasons.push("BYBIT_API_KEY is required");
  }

  if (config.bybitApiSecret === "") {
    blockedReasons.push("BYBIT_API_SECRET is required");
  }

  if (config.bybitEnvironment === "mainnet") {
    blockedReasons.push("BYBIT_ENV must be demo or testnet for the first live smoke");
  }

  return {
    dryRun: config.dryRun,
    liveTradingEnabled: config.liveTradingEnabled,
    bybitEnvironment: config.bybitEnvironment,
    bybitTestnet: config.bybitTestnet,
    bybitApiKeyConfigured: config.bybitApiKey !== "",
    bybitApiSecretConfigured: config.bybitApiSecret !== "",
    canExecuteLive: blockedReasons.length === 0,
    blockedReasons,
  };
}
