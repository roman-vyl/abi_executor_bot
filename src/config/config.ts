import { readFileSync } from "node:fs";

export type AbiConfig = {
  host: string;
  port: number;
  dryRun: boolean;
  liveTradingEnabled: boolean;
  entryPackageCorrelationPath: string;
  instrumentRulesCacheTtlMs: number;
  bybitRequestTimeoutMs: number;
  bybitReadTimeoutMs: number;
  bybitEnvironment: "demo" | "testnet" | "mainnet";
  bybitTestnet: boolean;
  bybitApiKey: string;
  bybitApiSecret: string;
  bybitAccountType: string;
  bybitRecvWindow: string;
  bybitCategory: string;
  bybitSettleCoin: string;
  bybitTriggerBy: string;
  bybitLinearPositionBindingMode: "one_way" | "hedge";
  positionSizingMode: PositionSizingMode;
  exchangeFactsEnabled: boolean;
  exchangeFactsDbPath: string;
  // Read once at start from the optional ABI_CONFIG_PATH JSON file
  // (abi-live-entry-mode-config-v1); nothing depends on them yet.
  liveEntryMode: LiveEntryMode;
  touchTriggerEntryOrderType: TouchTriggerEntryOrderType | null;
};

export type PositionSizingMode = "minimum" | "risk";
export type LiveEntryMode = "ema_anchor" | "touch_trigger";
export type TouchTriggerEntryOrderType = "market" | "limit";

type LiveEntryConfig = {
  liveEntryMode: LiveEntryMode;
  touchTriggerEntryOrderType: TouchTriggerEntryOrderType | null;
};

const LIVE_ENTRY_MODES: readonly LiveEntryMode[] = ["ema_anchor", "touch_trigger"];
const TOUCH_TRIGGER_ENTRY_ORDER_TYPES: readonly TouchTriggerEntryOrderType[] = ["market", "limit"];
const CONFIG_FILE_KEYS = new Set(["live_entry_mode", "touch_trigger_entry_order_type"]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AbiConfig {
  const bybitEnvironment = readBybitEnvironment(env);
  const bybitApiKey = env.BYBIT_API_KEY?.trim() ?? "";
  const bybitApiSecret = env.BYBIT_API_SECRET?.trim() ?? "";
  const positionSizingMode = readPositionSizingMode(env.ABI_POSITION_SIZING_MODE);
  const liveEntryConfig = readLiveEntryConfigFile(env.ABI_CONFIG_PATH);
  // Risk sizing reads the wallet balance on every entry, so it cannot run
  // without credentials — also in dry-run, where those reads still happen.
  if (positionSizingMode === "risk" && (bybitApiKey === "" || bybitApiSecret === "")) {
    throw new Error("ABI_POSITION_SIZING_MODE=risk requires BYBIT_API_KEY and BYBIT_API_SECRET");
  }

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
    // GET (read-only) requests only: a hung read is cut here and retried once.
    bybitReadTimeoutMs: readPositiveInt("ABI_BYBIT_READ_TIMEOUT_MS", env.ABI_BYBIT_READ_TIMEOUT_MS, 1_500),
    bybitEnvironment,
    bybitTestnet: bybitEnvironment === "testnet",
    bybitApiKey,
    bybitApiSecret,
    bybitAccountType: readString("BYBIT_ACCOUNT_TYPE", env.BYBIT_ACCOUNT_TYPE, "UNIFIED", (value) => value.toUpperCase()),
    bybitRecvWindow: readPositiveNumberString("BYBIT_RECV_WINDOW", env.BYBIT_RECV_WINDOW, "5000"),
    bybitCategory: readString("BYBIT_CATEGORY", env.BYBIT_CATEGORY, "linear", (value) => value.toLowerCase()),
    bybitSettleCoin: readString("BYBIT_SETTLE_COIN", env.BYBIT_SETTLE_COIN, "USDT", (value) => value.toUpperCase()),
    bybitTriggerBy: readString("BYBIT_TRIGGER_BY", env.BYBIT_TRIGGER_BY, "LastPrice"),
    bybitLinearPositionBindingMode: readLinearPositionBindingMode(env.ABI_BYBIT_LINEAR_POSITION_BINDING_MODE),
    positionSizingMode,
    exchangeFactsEnabled: readStrictBool("ABI_EXCHANGE_FACTS_ENABLED", env.ABI_EXCHANGE_FACTS_ENABLED, false),
    // One database per Bybit environment (abi-exchange-facts-sqlite-foundation-v1 D6);
    // the environment recorded inside the file is what protects it, not the name.
    exchangeFactsDbPath: readString(
      "ABI_EXCHANGE_FACTS_DB_PATH",
      env.ABI_EXCHANGE_FACTS_DB_PATH,
      `./var/abi_exchange_facts_${bybitEnvironment}.sqlite3`,
    ),
    liveEntryMode: liveEntryConfig.liveEntryMode,
    touchTriggerEntryOrderType: liveEntryConfig.touchTriggerEntryOrderType,
  };
}

function readLiveEntryConfigFile(pathValue: string | undefined): LiveEntryConfig {
  const defaults: LiveEntryConfig = { liveEntryMode: "ema_anchor", touchTriggerEntryOrderType: null };
  const path = pathValue?.trim() ?? "";
  if (path === "") {
    return defaults;
  }

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    // Only a missing file means "no configuration"; any other read failure stops startup.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaults;
    }
    throw new Error(`ABI_CONFIG_PATH file ${path} cannot be read: ${(error as Error).message}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`ABI_CONFIG_PATH file ${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`ABI_CONFIG_PATH file ${path} must contain a JSON object`);
  }

  const values = data as Record<string, unknown>;
  const unknown = Object.keys(values).filter((key) => !CONFIG_FILE_KEYS.has(key)).sort();
  if (unknown.length > 0) {
    throw new Error(`ABI_CONFIG_PATH file ${path} has unknown keys: ${unknown.join(", ")}`);
  }

  const liveEntryMode = readAllowed("live_entry_mode", values.live_entry_mode, LIVE_ENTRY_MODES) ?? "ema_anchor";
  const touchTriggerEntryOrderType = readAllowed(
    "touch_trigger_entry_order_type",
    values.touch_trigger_entry_order_type,
    TOUCH_TRIGGER_ENTRY_ORDER_TYPES,
  );
  if (liveEntryMode === "touch_trigger" && touchTriggerEntryOrderType === null) {
    throw new Error("touch_trigger_entry_order_type is required when live_entry_mode is touch_trigger");
  }
  // Temporary until limit entry exists (abi-touch-trigger-market-entry-v1);
  // removed by ABI-2.
  if (liveEntryMode === "touch_trigger" && touchTriggerEntryOrderType === "limit") {
    throw new Error("touch_trigger_entry_order_type limit is not implemented yet; use market");
  }

  return { liveEntryMode, touchTriggerEntryOrderType };
}

function readAllowed<T extends string>(name: string, value: unknown, allowed: readonly T[]): T | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }

  return value as T;
}

function readPositionSizingMode(value: string | undefined): PositionSizingMode {
  if (value === undefined) {
    return "minimum";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "minimum" || normalized === "risk") {
    return normalized;
  }

  throw new Error("ABI_POSITION_SIZING_MODE must be one of: minimum, risk");
}

function readLinearPositionBindingMode(value: string | undefined): "one_way" | "hedge" {
  if (value === undefined) {
    return "one_way";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "one_way" || normalized === "hedge") {
    return normalized;
  }

  throw new Error("ABI_BYBIT_LINEAR_POSITION_BINDING_MODE must be one of: one_way, hedge");
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

function readStrictBool(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }

  throw new Error(`${name} must be true or false`);
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
