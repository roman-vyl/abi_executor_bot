export type AbiConfig = {
  host: string;
  port: number;
  dryRun: boolean;
  liveTradingEnabled: boolean;
  allowedSymbols: string[];
  journalPath: string;
  fixedSmokeQty: string;
  bybitEnvironment: "demo" | "testnet" | "mainnet";
  bybitTestnet: boolean;
  bybitApiKey: string;
  bybitApiSecret: string;
  bybitAccountType: string;
  bybitRecvWindow: string;
  bybitCategory: string;
  bybitSettleCoin: string;
  bybitTriggerBy: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AbiConfig {
  return {
    host: env.ABI_HOST ?? "0.0.0.0",
    port: readInt(env.ABI_PORT, 8787),
    dryRun: readBool(env.ABI_DRY_RUN, true),
    liveTradingEnabled: readBool(env.ABI_LIVE_TRADING_ENABLED, false),
    allowedSymbols: readCsv(env.ABI_ALLOWED_SYMBOLS, ["BTCUSDT"]),
    journalPath: env.ABI_JOURNAL_PATH ?? "./var/abi_journal.jsonl",
    fixedSmokeQty: readPositiveNumberString(env.ABI_FIXED_SMOKE_QTY, "0.001"),
    bybitEnvironment: readBybitEnvironment(env),
    bybitTestnet: readBybitEnvironment(env) === "testnet",
    bybitApiKey: env.BYBIT_API_KEY?.trim() ?? "",
    bybitApiSecret: env.BYBIT_API_SECRET?.trim() ?? "",
    bybitAccountType: env.BYBIT_ACCOUNT_TYPE?.trim().toUpperCase() || "UNIFIED",
    bybitRecvWindow: readPositiveNumberString(env.BYBIT_RECV_WINDOW, "5000"),
    bybitCategory: env.BYBIT_CATEGORY?.trim().toLowerCase() || "linear",
    bybitSettleCoin: env.BYBIT_SETTLE_COIN?.trim().toUpperCase() || "USDT",
    bybitTriggerBy: env.BYBIT_TRIGGER_BY?.trim() || "LastPrice",
  };
}

function readBybitEnvironment(env: NodeJS.ProcessEnv): "demo" | "testnet" | "mainnet" {
  const explicit = env.BYBIT_ENV?.trim().toLowerCase();
  if (explicit === "demo" || explicit === "testnet" || explicit === "mainnet") {
    return explicit;
  }

  return readBool(env.BYBIT_TESTNET, true) ? "testnet" : "mainnet";
}

function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function readInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return parsed;
}

function readCsv(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = value
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : fallback;
}

function readPositiveNumberString(value: string | undefined, fallback: string): string {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return trimmed;
}
