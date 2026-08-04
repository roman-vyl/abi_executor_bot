import type { AbiConfig } from "../config/config.js";
import type { BybitAdapter } from "./bybitAdapter.js";
import { decodeInstrumentTradingRulesResponse } from "./instrumentTradingRulesResponseDecoder.js";
import type { InstrumentTradingRules } from "./instrumentTradingRulesResponseDecoder.js";

export type { InstrumentTradingRules };

export interface InstrumentTradingRulesProvider {
  getRules(symbol: string, category: "linear" | "spot"): Promise<InstrumentTradingRules>;
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

  async getRules(symbol: string, category: "linear" | "spot"): Promise<InstrumentTradingRules> {
    const cacheKey = `${category}:${symbol}`;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.rules;
    }

    const response = await this.bybit.getInstrumentInfo(category, symbol);
    const decoded = decodeInstrumentTradingRulesResponse({ response, expected: { category, symbol } });
    if (!decoded.ok) {
      throw new Error(`Bybit instruments-info response for ${symbol} is invalid: ${decoded.reason}`);
    }

    this.cache.set(cacheKey, { rules: decoded.rules, expiresAt: now + this.ttlMs });
    return decoded.rules;
  }
}
