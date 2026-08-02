## Context

See proposal.md - Why. Current code, confirmed by reading the repository:

- `EntryPackageApplicationServiceDeps.resolveSymbol: (ticker: string) => string`
  (`src/services/entryPackage/entryPackageApplicationService.ts:38`), called once at
  line 144 in `createOrder`. Every other branch (`replaceAmend`, `replaceCancelAndCreate`,
  `repeatPutRevalidate`, `metadataOnlyUpdate`, `cancelLiveOrder`) already reads
  `record.exchange_symbol` back from the correlation record instead of re-resolving —
  this change does not need to add that reuse behavior, only to make sure the record also
  carries `exchange_category` so those same read-backs stay correct once category exists.
- Composition root: `src/app/server.ts:53`, `resolveSymbol: () => { throw ... }`.
- `EntryPackageOrderInput` (`src/exchange/bybitOrderMapper.ts:149-158`) has a `symbol:
  string` field with a comment "Already-resolved Bybit symbol — never a raw Runtime
  ticker"; `mapEntryPackageToBybit` reads `config.bybitCategory` directly for every
  payload it builds (lines 184, 203, 220, 225, 231).
- `InstrumentTradingRulesProvider.getRules(symbol: string)` (`src/exchange/instrumentTradingRulesProvider.ts:11,33`)
  caches by bare `symbol` (`Map<string, CacheEntry>`, lines 26, 35, 42); called from
  `src/risk/positionSizeCalculator.ts:45` with `context.resolvedSymbol`.
- `EntryPackageExecutionRecord`/`BindingHistoryEntry` (`src/correlation/entryPackageExecutionRecord.ts`)
  already store `ticker` and `exchange_symbol`; no `category` field exists yet.

## Goals / Non-Goals

**Goals:**
- Replace the throwing `resolveSymbol` stub with a real, small, deterministic resolver
  producing `{ ticker, symbol, category, product }`.
- Update only the direct consumers of the previously-bare symbol string so they compile
  and behave correctly against the new object shape: the application service's one call
  site, the Bybit payload builder, the trading-rules provider signature/cache, and the
  correlation record's stored fields.

**Non-Goals:**
- No change to how quantity/position sizing is calculated, how spot TP/SL would work, or
  any other downstream algorithm — those keep receiving the same kind of value
  (`symbol`, plus now `category` where they already needed it from global config) and are
  otherwise untouched.
- No ticker-mapping registry, alias table, or database lookup.
- No change to the legacy `/signals`/`/intents/*` contour or `mapExecutionPlanToBybit`.
- No change to the public entry-package HTTP contract.

## Decisions

### 1. Module: `ExchangeInstrumentResolver` in `src/exchange/exchangeInstrumentResolver.ts`

```ts
const SPOT_PATTERN = /^[A-Z0-9]+$/;
const LINEAR_PATTERN = /^[A-Z0-9]+\.P$/;

export type ExchangeInstrumentIdentity = {
  ticker: string;
  symbol: string;
  category: "linear" | "spot";
  product: "perpetual" | "spot";
};

export interface ExchangeInstrumentResolver {
  resolve(ticker: string): ExchangeInstrumentIdentity;
}

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
```

Synchronous (no I/O), matching the requirement that resolution is deterministic and
local. The ticker is validated against exactly two grammars —
`[A-Z0-9]+` (spot) and `[A-Z0-9]+\.P` (linear perpetual) — anchored at both ends, so
anything that doesn't fully match either (extra trailing characters as in `BTCUSDT.PX`,
a second `.`-delimited segment as in `BTC.USDT`, embedded whitespace as in `BTC USDT`,
empty string, or the suffix alone `.P`) falls through to the typed error. This replaces
an earlier draft of this design that let a non-trailing `.P` fall through to the spot
branch unchanged — that was wrong: a malformed ticker must fail closed, not silently
resolve to a guessed spot symbol containing invalid characters. `product` is kept
alongside `category` per the proposal's explicit target shape — it is a plain
deterministic function of `category` (`linear → perpetual`, `spot → spot`), so it costs
nothing extra to compute or store, and existing/future consumers that want the
human-readable semantics (e.g. logs, correlation-record readers) don't have to re-derive
it from `category` themselves.

### 2. Where it's called: the one existing call site

`createOrder`'s `const resolvedSymbol = this.deps.resolveSymbol(command.ticker);`
becomes `const identity = this.deps.exchangeInstrumentResolver.resolve(command.ticker);`,
and the handful of places in that same function that used `resolvedSymbol` as a bare
string read `identity.symbol` / `identity.category` instead. No other branch changes,
since no other branch calls the resolver today (they already read the correlation
record).

### 3. Direct-consumer adaptation, not redesign

- `EntryPackageOrderInput` gains `category: "linear" | "spot"`; `mapEntryPackageToBybit`
  uses `input.category` instead of `config.bybitCategory` for the five entry-package
  payloads it builds. This is a signature change only — no payload field beyond the
  existing `category` key changes.
- `EntryPackageExecutionRecord`/`BindingHistoryEntry` gain `exchange_category: string`
  next to `exchange_symbol`, set from `identity.category` at the same place
  `exchange_symbol` is already set.
- **Every existing-binding call site that currently reads `config.bybitCategory` inline
  must instead read the binding's stored `record.exchange_category`.** Confirmed by
  reading the code, these are not hypothetical: `entryPackageApplicationService.ts`
  builds cancel/get/get-history payloads directly (not through the mapper) at four
  places — `{ category: this.deps.config.bybitCategory, symbol, orderLinkId }` (line
  ~322, cancel), `{ category: this.deps.config.bybitCategory, symbol, orderLinkId,
  limit: "1" }` twice (lines ~355-356, get + get-history) in one branch, and the same
  three-payload group again at lines ~526, ~548-549 in another branch. All four/six of
  these become `{ category: record.exchange_category, symbol: record.exchange_symbol,
  ... }`. Storing `exchange_category` on the record without also making these call sites
  read it back would be a no-op change dressed up as a fix — the field would sit unused
  and every existing-binding call would keep silently defaulting to the global
  configuration, exactly the bug this change exists to remove.
- `InstrumentTradingRulesProvider.getRules(symbol, category)`: the cache key becomes
  `` `${category}:${symbol}` `` instead of bare `symbol` — this is the minimal change
  required so that adding `category` as an input doesn't let a `linear` lookup and a
  `spot` lookup for the same symbol collide in the cache (a straightforward correctness
  consequence of the signature change, not a new caching design).
  `FixedMinimumPositionSizeCalculator`'s call site passes the resolved category through
  unchanged otherwise; the sizing formula itself is not touched.
- **The cache key change is not sufficient by itself.** `getRules` currently calls
  `this.bybit.getInstrumentInfo(symbol)` (`instrumentTradingRulesProvider.ts:35`), and
  `RestBybitAdapter.getInstrumentInfo(symbol)` (`bybitAdapter.ts:162-172`) builds its own
  request with `category: this.config.bybitCategory` — the global value, ignoring
  whatever category `getRules` was called with. Left unchanged, `getRules("BTCUSDT",
  "spot")` would cache under `spot:BTCUSDT` while the actual Bybit request still asked for
  `category=linear`, caching a linear response under a spot key. `BybitAdapter.getInstrumentInfo`
  (interface, `RestBybitAdapter`, and `StubBybitAdapter`) therefore changes to
  `getInstrumentInfo(category: string, symbol: string)`, and `RestBybitAdapter`'s
  implementation uses the passed-in `category` instead of `this.config.bybitCategory`
  when building the instruments-info request. `getRules` passes its own `category`
  parameter through to this call. This is the same class of direct-consumer fix as the
  mapper and correlation-record changes above — `getInstrumentInfo` is the immediate
  downstream consumer of `getRules`'s new `category` parameter, not a new architectural
  layer.

### 4. Composition root

`src/app/server.ts` constructs `new BybitExchangeInstrumentResolver()` and passes it as
`exchangeInstrumentResolver` to `EntryPackageApplicationService`, replacing the throwing
`resolveSymbol` stub and its startup warning.

## Risks / Trade-offs

- [Cache key change in `InstrumentTradingRulesProvider` touches a shared adapter-layer
  file] → Change is additive to the key shape only (`symbol` → `category:symbol`); no
  behavior change for a process that only ever sees one category.
- [Correlation record gains a required field] → No live production records exist yet
  (the resolver has always thrown in every environment that reached this code), so there
  is no real backward-compatibility concern; any test fixtures constructing the record
  directly are updated alongside the type change.
