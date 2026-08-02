## Why

`EntryPackageApplicationService` currently depends on a temporary
`resolveSymbol: (ticker: string) => string` (`src/services/entryPackage/entryPackageApplicationService.ts:38`,
called at line 144), wired at the composition root
(`src/app/server.ts:53`) to a function that unconditionally throws. This
placeholder is the one remaining thing blocking real Bybit calls for the
entry-package contour. It is also the wrong shape: collapsing
`BTCUSDT.P` and `BTCUSDT` to the same string symbol loses the distinction
between a linear perpetual and a spot instrument, and Bybit requires a
`category` on every call. This change adds a small resolver that returns
that distinction and wires it in, replacing the throwing stub.

## What Changes

- Add one new small module: an `ExchangeInstrumentResolver` that maps a
  Runtime `ticker` to an `ExchangeInstrumentIdentity` (`ticker`, `symbol`,
  `category`, `product`), recognizing a trailing `.P` suffix as
  `linear`/`perpetual` (suffix stripped from `symbol`) and its absence as
  `spot`/`spot` (symbol unchanged), with a minimal check rejecting a
  degenerate ticker.
- Replace the throwing `resolveSymbol` stub in `src/app/server.ts` with a
  constructed resolver instance, passed to `EntryPackageApplicationService`.
- Replace `EntryPackageApplicationServiceDeps.resolveSymbol` with
  `exchangeInstrumentResolver: ExchangeInstrumentResolver`; replace the one
  call site (`createOrder`) to call `.resolve(command.ticker)` and read
  `identity.symbol` / `identity.category` / `identity.product` from the
  result instead of a bare string.
- Adapt only the immediate, direct consumers of the previously-bare symbol
  string to accept the fields they need from the identity instead:
  - `mapEntryPackageToBybit`'s input gains `category` (from
    `identity.category`) alongside the existing `symbol`, instead of that
    payload builder reading the global `config.bybitCategory` for the
    entry-package contour.
  - `InstrumentTradingRulesProvider.getRules(symbol)` becomes
    `getRules(symbol, category)`, since it must ask Bybit's
    instruments-info endpoint for the right category.
  - The entry-package correlation record gains one additional stored field,
    `exchange_category`, next to the existing `exchange_symbol`, so a later
    amend/cancel/query on the same binding still knows which category to
    use without re-resolving.

**Explicitly not in scope:** no redesign of position sizing, quantity
calculation, spot TP/SL handling, conditional-entry semantics, or any other
downstream algorithm — this change only changes what identity those
algorithms are handed (an object instead of a bare string), not how they
use it. No ticker-mapping registry, alias table, or database lookup. No
change to the Runtime → ABI public entry-package DTO. No change to legacy
`/signals`/`/intents/*` or to `config.bybitCategory`'s use there.

## Capabilities

### New Capabilities
- `exchange-instrument-identity`: deterministic, local resolution of a
  Runtime ticker into `{ ticker, symbol, category, product }`, replacing
  the temporary `resolveSymbol` placeholder.

### Modified Capabilities
- `entry-package-execution`: the resolver dependency changes shape (object
  instead of bare string); the resolved `category` is threaded to the
  Bybit payload builder and instrument-rules lookup instead of the global
  `config.bybitCategory`; the correlation record durably stores
  `exchange_category` alongside the existing `exchange_symbol`.

## Impact

- New: `src/exchange/exchangeInstrumentResolver.ts` + unit tests.
- Modified: `src/app/server.ts` (wiring), `src/services/entryPackage/entryPackageApplicationService.ts`
  (dependency + call site), `src/exchange/bybitOrderMapper.ts` (`EntryPackageOrderInput`
  gains `category`), `src/exchange/instrumentTradingRulesProvider.ts` (`getRules` gains
  `category`, cache key becomes category-aware so it doesn't collide), `src/risk/positionSizeCalculator.ts`
  (pass-through of `category` to `getRules`, no change to sizing logic itself),
  `src/correlation/entryPackageExecutionRecord.ts` (add `exchange_category` field).
- Not modified: `src/domain/entryPackageApi.ts`, `src/exchange/bybitOrderMapper.ts`'s
  `mapExecutionPlanToBybit`, `src/domain/signals.ts`, `src/services/signals/*`,
  `src/services/intents/*`, `config.bybitCategory` itself (remains for legacy use).
