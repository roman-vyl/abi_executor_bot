## 1. Order-price-limits contract and decoder

- [x] 1.1 Create the compact `src/exchange/orderPriceLimits/` module boundary with request, `CurrentOrderPriceLimits`, protocol-reason, typed failure, provider-result, and provider-interface types matching the design's discriminated contract.
- [x] 1.2 Implement the pure endpoint decoder for a successful `/v5/market/price-limit` envelope: exact symbol match, arithmetic-safe positive `buyLmt`/`sellLmt`, positive safe-integer envelope `time`, and canonical positive safe-integer `result.ts` mapped to `observedAtMs`.
- [x] 1.3 Ensure every malformed-envelope, symbol-mismatch, invalid-buy-limit, invalid-sell-limit, and invalid-timestamp branch returns its typed protocol reason without throwing or manufacturing a fallback value.

## 2. Bybit transport primitive

- [x] 2.1 Add only `getOrderPriceLimit(category, symbol): Promise<unknown>` to the `BybitAdapter` interface and implement the unsigned Rest adapter GET to `/v5/market/price-limit` with both explicit query parameters and the existing timeout/response boundary.
- [x] 2.2 Extend `FakeBybitAdapter` with exact call capture plus configurable raw response/rejection behavior for the new primitive, without changing existing fake defaults or callers.

## 3. Fresh typed provider

- [x] 3.1 Implement the Bybit-backed provider so every category other than literal `linear` returns typed `unsupported_category` before adapter access, while every supported request passes the exact category and symbol to the adapter.
- [x] 3.2 Map adapter rejection to typed `transport_failure`, decoded invalid data to typed `protocol_failure`, and valid data to typed success while preserving the exact limit strings.
- [x] 3.3 Keep the provider cache-free and issue exactly one fresh adapter call per supported invocation; do not construct or inject it into `server.ts` or any application service in this foundation change.

## 4. Focused tests

- [x] 4.1 Add decoder tests proving a valid linear response succeeds and preserves exact `buyLmt`/`sellLmt` strings while mapping `result.ts` to `observedAtMs`.
- [x] 4.2 Add decoder tests for missing, non-string, non-decimal, arithmetic-unsafe, zero, and negative `buyLmt`, each returning `invalid_buy_limit` with no snapshot.
- [x] 4.3 Add the equivalent missing, malformed, zero, and negative `sellLmt` tests, each returning `invalid_sell_limit` with no snapshot.
- [x] 4.4 Add decoder tests for missing/non-canonical/non-string/unsafe `result.ts`, malformed or rejected Bybit envelopes (including malformed envelope `time`), and mismatched/missing symbol.
- [x] 4.5 Add provider tests proving adapter transport rejection is typed, unsupported category fails closed without an adapter call, and two same-instrument requests make two adapter calls and decode the second response freshly.
- [x] 4.6 Add a focused module-boundary assertion or equivalent source-level test proving the new module does not import protection, Runtime, strategy, correlation, application-service, or `InstrumentTradingRules` business semantics and exposes no price-side mapping, clamping, or surrogate calculation.

## 5. Verification and scope audit

- [x] 5.1 Run `npm test`.
- [x] 5.2 Run `npm run typecheck`.
- [x] 5.3 Inspect the implementation diff and confirm it contains no protection service, native attribution, Change 7, entry record, correlation repository, public HTTP API, Runtime, master-plan, retry, persistence, or cache changes.
