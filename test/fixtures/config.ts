import type { AbiConfig } from "../../src/config/config.js";

export function makeTestConfig(overrides: Partial<AbiConfig> = {}): AbiConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    dryRun: true,
    liveTradingEnabled: false,
    allowedSymbols: ["BTCUSDT"],
    journalPath: "/tmp/abi-test-journal.jsonl",
    entryPackageCorrelationPath: "/tmp/abi-test-entry-package-correlation.jsonl",
    instrumentRulesCacheTtlMs: 300_000,
    fixedSmokeQty: "0.001",
    bybitEnvironment: "testnet",
    bybitTestnet: true,
    bybitApiKey: "",
    bybitApiSecret: "",
    bybitAccountType: "UNIFIED",
    bybitRecvWindow: "5000",
    bybitCategory: "linear",
    bybitSettleCoin: "USDT",
    bybitTriggerBy: "LastPrice",
    ...overrides,
  };
}
