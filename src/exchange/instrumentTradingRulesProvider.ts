import type { AbiConfig } from "../config/config.js";
import type { BybitAdapter } from "./bybitAdapter.js";

export type InstrumentTradingRules = {
  minOrderQty: string;
  qtyStep: string;
  minNotionalValue: string;
};

export interface InstrumentTradingRulesProvider {
  getRules(symbol: string): Promise<InstrumentTradingRules>;
}

type CacheEntry = {
  rules: InstrumentTradingRules;
  expiresAt: number;
};

// Lazy per-resolved-symbol lookup with an in-memory TTL cache. A lookup
// failure for one symbol must fail only the command that requested it
// (thrown here, mapped to internal_error by the application service) — it
// must never be treated as a whole-service readiness failure (design.md §7).
export class BybitInstrumentTradingRulesProvider implements InstrumentTradingRulesProvider {
  private readonly bybit: BybitAdapter;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(bybit: BybitAdapter, config: AbiConfig) {
    this.bybit = bybit;
    this.ttlMs = config.instrumentRulesCacheTtlMs;
  }

  async getRules(symbol: string): Promise<InstrumentTradingRules> {
    const now = Date.now();
    const cached = this.cache.get(symbol);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.rules;
    }

    const response = await this.bybit.getInstrumentInfo(symbol);
    const rules = parseInstrumentTradingRules(response, symbol);
    this.cache.set(symbol, { rules, expiresAt: now + this.ttlMs });
    return rules;
  }
}

function parseInstrumentTradingRules(response: unknown, symbol: string): InstrumentTradingRules {
  const item = readInstrumentListItem(response);
  if (item === undefined) {
    throw new Error(`Bybit instruments-info response did not include symbol ${symbol}`);
  }

  const lotSizeFilter = item.lotSizeFilter;
  if (typeof lotSizeFilter !== "object" || lotSizeFilter === null) {
    throw new Error(`Bybit instruments-info response for ${symbol} is missing lotSizeFilter`);
  }

  const record = lotSizeFilter as Record<string, unknown>;
  const minOrderQty = readRecordString(record, "minOrderQty");
  const qtyStep = readRecordString(record, "qtyStep");
  const minNotionalValue = readRecordString(record, "minNotionalValue");

  if (minOrderQty === "" || qtyStep === "" || minNotionalValue === "") {
    throw new Error(`Bybit instruments-info response for ${symbol} is missing lot size fields`);
  }

  return { minOrderQty, qtyStep, minNotionalValue };
}

function readInstrumentListItem(response: unknown): { lotSizeFilter: unknown } | undefined {
  if (typeof response !== "object" || response === null || !("result" in response)) {
    return undefined;
  }

  const result = (response as Record<string, unknown>).result;
  if (typeof result !== "object" || result === null || !("list" in result)) {
    return undefined;
  }

  const list = (result as Record<string, unknown>).list;
  if (!Array.isArray(list) || list.length === 0) {
    return undefined;
  }

  const item = list[0];
  if (typeof item !== "object" || item === null) {
    return undefined;
  }

  return item as { lotSizeFilter: unknown };
}

function readRecordString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}
