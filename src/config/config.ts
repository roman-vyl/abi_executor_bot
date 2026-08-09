export type AbiConfig = {
  host: string;
  port: number;
  dryRun: boolean;
  liveTradingEnabled: boolean;
  entryPackageCorrelationPath: string;
  instrumentRulesCacheTtlMs: number;
  bybitRequestTimeoutMs: number;
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
  const bybitEnvironment = readBybitEnvironment(env);

  return {
    host: readString("ABI_HOST", env.ABI_HOST, "127.0.0.1"),
    port: readPort(env.ABI_PORT, 8787),
    dryRun: readBool("ABI_DRY_RUN", env.ABI_DRY_RUN, true),
    liveTradingEnabled: readBool("ABI_LIVE_TRADING_ENABLED", env.ABI_LIVE_TRADING_ENABLED, false),
    entryPackageCorrelationPath: readString(
      "ABI_ENTRY_PACKAGE_CORRELATION_PATH",
      env.ABI_ENTRY_PACKAGE_CORRELATION_PATH,
      "./var/abi_entry_package_correlation.jsonl",
    ),
    instrumentRulesCacheTtlMs: readPositiveInt(
      "ABI_INSTRUMENT_RULES_CACHE_TTL_MS",
      env.ABI_INSTRUMENT_RULES_CACHE_TTL_MS,
      300_000,
    ),
    bybitRequestTimeoutMs: readPositiveInt("ABI_BYBIT_REQUEST_TIMEOUT_MS", env.ABI_BYBIT_REQUEST_TIMEOUT_MS, 10_000),
    bybitEnvironment,
    bybitTestnet: bybitEnvironment === "testnet",
    bybitApiKey: env.BYBIT_API_KEY?.trim() ?? "",
    bybitApiSecret: env.BYBIT_API_SECRET?.trim() ?? "",
    bybitAccountType: readString("BYBIT_ACCOUNT_TYPE", env.BYBIT_ACCOUNT_TYPE, "UNIFIED", (value) => value.toUpperCase()),
    bybitRecvWindow: readPositiveNumberString("BYBIT_RECV_WINDOW", env.BYBIT_RECV_WINDOW, "5000"),
    bybitCategory: readString("BYBIT_CATEGORY", env.BYBIT_CATEGORY, "linear", (value) => value.toLowerCase()),
    bybitSettleCoin: readString("BYBIT_SETTLE_COIN", env.BYBIT_SETTLE_COIN, "USDT", (value) => value.toUpperCase()),
    bybitTriggerBy: readString("BYBIT_TRIGGER_BY", env.BYBIT_TRIGGER_BY, "LastPrice"),
  };
}

function readBybitEnvironment(env: NodeJS.ProcessEnv): "demo" | "testnet" | "mainnet" {
  if (env.BYBIT_ENV !== undefined) {
    const explicit = env.BYBIT_ENV.trim().toLowerCase();
    if (explicit === "demo" || explicit === "testnet" || explicit === "mainnet") {
      return explicit;
    }

    throw new Error("BYBIT_ENV must be one of: demo, testnet, mainnet");
  }

  return readBool("BYBIT_TESTNET", env.BYBIT_TESTNET, true) ? "testnet" : "mainnet";
}

function readBool(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`${name} must be a boolean value`);
}

function readPort(value: string | undefined, fallback: number): number {
  const parsed = readPositiveInt("ABI_PORT", value, fallback);
  if (parsed > 65_535) {
    throw new Error("ABI_PORT must be between 1 and 65535");
  }

  return parsed;
}

function readPositiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`${name} must be an integer`);
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (parsed <= 0) {
    throw new Error(`${name} must be greater than 0`);
  }

  return parsed;
}

function readPositiveNumberString(name: string, value: string | undefined, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }

  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }

  return trimmed;
}

function readString(
  name: string,
  value: string | undefined,
  fallback: string,
  transform: (value: string) => string = (input) => input,
): string {
  if (value === undefined) {
    return fallback;
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error(`${name} must not be empty`);
  }

  return transform(trimmed);
}
