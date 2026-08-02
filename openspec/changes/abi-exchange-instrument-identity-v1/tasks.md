## 1. Resolver

- [ ] 1.1 Add `src/exchange/exchangeInstrumentResolver.ts`: `ExchangeInstrumentIdentity`
      type, `ExchangeInstrumentResolver` port, `ExchangeInstrumentResolutionError`, and
      `BybitExchangeInstrumentResolver` implementation per design.md Decision 1.
- [ ] 1.2 Unit test: `BTCUSDT.P` → `{symbol: BTCUSDT, category: linear, product:
      perpetual}`; `ETHUSDT.P` → `{symbol: ETHUSDT, category: linear, product:
      perpetual}`; `BTCUSDT` → `{symbol: BTCUSDT, category: spot, product: spot}`;
      non-trailing `.P` (e.g. `BTCUSDT.PX`) resolves via the spot branch; empty ticker and
      `.P`-only ticker raise `ExchangeInstrumentResolutionError`.

## 2. Application service and composition root

- [ ] 2.1 Replace `EntryPackageApplicationServiceDeps.resolveSymbol` with
      `exchangeInstrumentResolver: ExchangeInstrumentResolver`.
- [ ] 2.2 Update `createOrder`'s call site to `this.deps.exchangeInstrumentResolver.resolve(command.ticker)`
      and use `identity.symbol` / `identity.category` in place of the old bare
      `resolvedSymbol` string.
- [ ] 2.3 Replace the throwing `resolveSymbol` stub in `src/app/server.ts` with a
      constructed `BybitExchangeInstrumentResolver`, passed as `exchangeInstrumentResolver`.

## 3. Direct consumers

- [ ] 3.1 Add `category: "linear" | "spot"` to `EntryPackageOrderInput`
      (`src/exchange/bybitOrderMapper.ts`); update `mapEntryPackageToBybit` to use
      `input.category` instead of `config.bybitCategory` for the five entry-package
      payloads. Do not modify `mapExecutionPlanToBybit`.
- [ ] 3.2 Change `InstrumentTradingRulesProvider.getRules` to `getRules(symbol, category)`
      and update `BybitInstrumentTradingRulesProvider`'s cache key to
      `` `${category}:${symbol}` ``; update its one call site in
      `src/risk/positionSizeCalculator.ts` to pass the resolved category through.
- [ ] 3.3 Add `exchange_category: string` to `EntryPackageExecutionRecord` and
      `BindingHistoryEntry` (`src/correlation/entryPackageExecutionRecord.ts`), set from
      `identity.category` alongside the existing `exchange_symbol`; update the record's
      runtime validator accordingly.
- [ ] 3.4 Update any test fixtures/doubles that construct `EntryPackageOrderInput`,
      call `getRules`, or construct an `EntryPackageExecutionRecord` directly, so they
      compile against the new signatures/fields.

## 4. Verification

- [ ] 4.1 Run `npm test`, `npm run typecheck`, `npm run build`.
- [ ] 4.2 Run `openspec validate --all --strict`.
- [ ] 4.3 Confirm no diff to `src/domain/entryPackageApi.ts`, `src/domain/signals.ts`,
      `src/services/signals/*`, `src/services/intents/*`, or `mapExecutionPlanToBybit`.
- [ ] 4.4 Sync specs and archive this change only after explicit user approval.
