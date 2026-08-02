## 1. Resolver

- [x] 1.1 Add `src/exchange/exchangeInstrumentResolver.ts`: `ExchangeInstrumentIdentity`
      type, `ExchangeInstrumentResolver` port, `ExchangeInstrumentResolutionError`, and
      `BybitExchangeInstrumentResolver` implementation per design.md Decision 1.
- [x] 1.2 Unit test the two accepted grammars: `BTCUSDT.P` → `{symbol: BTCUSDT, category:
      linear, product: perpetual}`; `ETHUSDT.P` → `{symbol: ETHUSDT, category: linear,
      product: perpetual}`; `BTCUSDT` → `{symbol: BTCUSDT, category: spot, product:
      spot}`.
- [x] 1.3 Unit test rejection of every malformed shape per design.md Decision 1 —
      `BTCUSDT.PX` (trailing extra characters), `BTC.USDT` (second `.`-delimited
      segment), `BTC USDT` (embedded whitespace), `.P` (suffix alone, no symbol), and
      empty string — each SHALL raise `ExchangeInstrumentResolutionError`, not resolve to
      a guessed spot symbol.

## 2. Application service and composition root

- [x] 2.1 Replace `EntryPackageApplicationServiceDeps.resolveSymbol` with
      `exchangeInstrumentResolver: ExchangeInstrumentResolver`.
- [x] 2.2 Update `createOrder`'s call site to `this.deps.exchangeInstrumentResolver.resolve(command.ticker)`
      and use `identity.symbol` / `identity.category` in place of the old bare
      `resolvedSymbol` string.
- [x] 2.3 Replace the throwing `resolveSymbol` stub in `src/app/server.ts` with a
      constructed `BybitExchangeInstrumentResolver`, passed as `exchangeInstrumentResolver`.

## 3. Direct consumers

- [x] 3.1 Add `category: "linear" | "spot"` to `EntryPackageOrderInput`
      (`src/exchange/bybitOrderMapper.ts`); update `mapEntryPackageToBybit` to use
      `input.category` instead of `config.bybitCategory` for the five entry-package
      payloads. Do not modify `mapExecutionPlanToBybit`.
- [x] 3.2 Add `exchange_category: string` to `EntryPackageExecutionRecord` and
      `BindingHistoryEntry` (`src/correlation/entryPackageExecutionRecord.ts`), set from
      `identity.category` alongside the existing `exchange_symbol`; update the record's
      runtime validator accordingly.
- [x] 3.3 Update every existing-binding payload built inline in
      `src/services/entryPackage/entryPackageApplicationService.ts` that currently reads
      `category: this.deps.config.bybitCategory` (cancel, get, and get-history payloads,
      confirmed at both branches building them — around lines 322, 355-356, and 526,
      548-549) to instead read `category: record.exchange_category` together with
      `symbol: record.exchange_symbol`. This is the task that makes the stored field
      from 3.2 actually used — do not skip it.
- [x] 3.4 Change `InstrumentTradingRulesProvider.getRules` to `getRules(symbol, category)`
      and update `BybitInstrumentTradingRulesProvider`'s cache key to
      `` `${category}:${symbol}` ``; update its one call site in
      `src/risk/positionSizeCalculator.ts` to pass the resolved category through.
- [x] 3.5 Change `BybitAdapter.getInstrumentInfo` (interface, `RestBybitAdapter`, and
      `StubBybitAdapter`) from `getInstrumentInfo(symbol)` to
      `getInstrumentInfo(category, symbol)`; update `RestBybitAdapter`'s implementation
      to use the passed-in `category` instead of `this.config.bybitCategory` when
      building the instruments-info request; update `getRules` (3.4) to pass its
      `category` parameter through to this call. Without this task, the cache key in 3.4
      would distinguish `linear:BTCUSDT`/`spot:BTCUSDT` while the real Bybit request
      underneath still always asked for the global category.
- [x] 3.6 Update any test fixtures/doubles that construct `EntryPackageOrderInput`, call
      `getRules`/`getInstrumentInfo`, or construct an `EntryPackageExecutionRecord`
      directly, so they compile against the new signatures/fields.

## 4. Verification

- [x] 4.1 Test that amend/cancel/realtime-query/history-query payloads for an existing
      binding use `record.exchange_category`/`record.exchange_symbol`, and that the
      underlying `getInstrumentInfo` call for a `spot`-resolved symbol is made with
      `category=spot` (not the global configuration value) — closing the gap where the
      cache key alone would distinguish categories but the real exchange call would not.
- [x] 4.2 Run `npm test`, `npm run typecheck`, `npm run build`.
- [x] 4.3 Run `openspec validate --all --strict`.
- [x] 4.4 Confirm no diff to `src/domain/entryPackageApi.ts`, `src/domain/signals.ts`,
      `src/services/signals/*`, `src/services/intents/*`, or `mapExecutionPlanToBybit`.
- [ ] 4.5 Sync specs and archive this change only after explicit user approval.
