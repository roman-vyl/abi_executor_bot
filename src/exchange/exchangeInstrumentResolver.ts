// Resolves a canonical Runtime ticker into the Bybit exchange instrument
// identity it maps to. Deterministic and local: no network I/O, no
// registry, no per-symbol configuration (design.md Decisions 1/4).
const SPOT_PATTERN = /^[A-Z0-9]+$/;
const LINEAR_PATTERN = /^[A-Z0-9]+\.P$/;

export type ExchangeInstrumentCategory = "linear" | "spot";

export type ExchangeInstrumentIdentity = {
  ticker: string;
  symbol: string;
  category: ExchangeInstrumentCategory;
  product: "perpetual" | "spot";
};

export interface ExchangeInstrumentResolver {
  resolve(ticker: string): ExchangeInstrumentIdentity;
}

export class ExchangeInstrumentResolutionError extends Error {
  readonly ticker: string;

  constructor(ticker: string) {
    super(`Cannot resolve exchange instrument identity for ticker: ${JSON.stringify(ticker)}`);
    this.name = "ExchangeInstrumentResolutionError";
    this.ticker = ticker;
  }
}

// Accepts only two ticker grammars: `[A-Z0-9]+` (spot) and `[A-Z0-9]+\.P`
// (linear perpetual). Anything else — a non-trailing `.P`, a second
// `.`-delimited segment, embedded whitespace, or empty input — fails
// closed rather than resolving to a best-guess identity (design.md
// Decision 1).
export class BybitExchangeInstrumentResolver implements ExchangeInstrumentResolver {
  resolve(ticker: string): ExchangeInstrumentIdentity {
    if (LINEAR_PATTERN.test(ticker)) {
      return {
        ticker,
        symbol: ticker.slice(0, -2),
        category: "linear",
        product: "perpetual",
      };
    }

    if (SPOT_PATTERN.test(ticker)) {
      return { ticker, symbol: ticker, category: "spot", product: "spot" };
    }

    throw new ExchangeInstrumentResolutionError(ticker);
  }
}
