## Context

Bybit exposes the current order-price band through public `GET /v5/market/price-limit`. For the documented response, the requested `category` is not echoed; `result` contains `symbol`, `buyLmt`, `sellLmt`, and the market snapshot timestamp `ts`, while the envelope also contains server `time`. See proposal.md for motivation and `specs/order-price-limits/spec.md` for the behavioral contract.

The existing `BybitInstrumentTradingRulesProvider` reads `instruments-info` and caches slow-moving sizing constraints. Reusing it would conflate a dynamic market snapshot with a different endpoint, response schema, failure contract, and freshness requirement.

## Goals / Non-Goals

**Goals:**

- Introduce a small exchange-layer port and Bybit implementation for fresh, linear-only order-price-limit snapshots.
- Keep HTTP transport, pure response decoding, and provider orchestration independently testable.
- Preserve exact decimal text and fail closed before any downstream consumer can receive malformed limits.
- Return all expected failure classes as a discriminated result.

**Non-Goals:**

- No application-service or public-route wiring in this foundation change.
- No strategy, position-side, protection, TP/SL, surrogate-price, clamping, or amend semantics.
- No retry, persistence, durable cache, in-memory TTL cache, or lifecycle/correlation state.
- No support for `spot` or `inverse` in V1.

## Decisions

### 1. Place endpoint semantics in a dedicated exchange submodule

Use a compact boundary under `src/exchange/orderPriceLimits/`:

- `types.ts` owns the request, snapshot, protocol-reason, failure, and result unions;
- `decoder.ts` is a pure decoder from `unknown` plus expected symbol to a decoded snapshot or typed protocol reason;
- `provider.ts` owns the provider interface and Bybit-backed orchestration.

The exact file split may be collapsed if implementation finds a smaller structure clearer, but the transport primitive, pure decoder, and provider responsibilities remain separate. This keeps `bybitAdapter.ts` from becoming the semantic decoder for another endpoint and prevents protection vocabulary from entering the module.

Alternative considered: place the provider beside `instrumentTradingRulesProvider.ts` and reuse its types/cache. Rejected because only filesystem proximity is shared; endpoint meaning, response shape, freshness, and consumer policy are different.

### 2. Add one transport-only adapter primitive

Extend `BybitAdapter` with:

```ts
getOrderPriceLimit(category: string, symbol: string): Promise<unknown>;
```

`RestBybitAdapter` performs an unsigned GET to `/v5/market/price-limit` with both query parameters and returns the parsed unknown response through the existing response-reading boundary. It performs no limit decoding or side/business mapping. The fake adapter records calls and supplies responses or failures for provider tests.

The provider checks `category === "linear"` before this call. Keeping the adapter signature transport-oriented also avoids pretending the transport layer has validated semantic data.

### 3. Return one explicit discriminated provider result

Use this conceptual contract:

```ts
type CurrentOrderPriceLimits = {
  buyLimit: string;
  sellLimit: string;
  observedAtMs: number;
};

type OrderPriceLimitsFailure =
  | { kind: "unsupported_category"; category: string }
  | { kind: "transport_failure" }
  | { kind: "protocol_failure"; reason: OrderPriceLimitsProtocolFailureReason };

type CurrentOrderPriceLimitsResult =
  | { kind: "success"; limits: CurrentOrderPriceLimits }
  | { kind: "failure"; failure: OrderPriceLimitsFailure };

interface CurrentOrderPriceLimitsProvider {
  getCurrent(input: { category: string; symbol: string }): Promise<CurrentOrderPriceLimitsResult>;
}
```

The final names may follow local naming conventions, but the discriminants and information boundary remain equivalent. Unsupported input is distinguished from a failed exchange call; an exchange call that completes with structurally or semantically invalid data is distinguished as a protocol failure. The provider catches adapter rejection and returns `transport_failure` rather than throwing.

Alternative considered: throw from the provider as `InstrumentTradingRulesProvider` currently does. Rejected because this capability has no application-service consumer translating exceptions, and the requested reusable boundary needs an explicit typed failure contract.

### 4. Decode the endpoint strictly and preserve decimal strings

The pure decoder validates, in order:

1. response is a non-null object;
2. `retCode` is exactly numeric `0`, `retMsg` is a string, envelope `time` is a positive safe integer, and `result` is a non-null object;
3. `result.symbol` exactly equals the requested symbol;
4. `buyLmt` and `sellLmt` are strings accepted by the arithmetic-safe exact-decimal parser and compare strictly greater than zero;
5. `result.ts` is a canonical positive integer string whose numeric value is a safe integer.

Suggested protocol reasons are `malformed_envelope`, `symbol_mismatch`, `invalid_buy_limit`, `invalid_sell_limit`, and `invalid_timestamp`. The decoder returns the original decimal strings; it converts only `result.ts` to `observedAtMs`. It never substitutes envelope `time` or `Date.now()` for a bad `result.ts`.

`category` cannot be read back because this endpoint does not return it. Identity safety is therefore established by rejecting non-linear input before transport, sending the explicit category parameter, and exact-matching the returned symbol. No fictitious category-response validation is specified.

Use the repository's arithmetic-safe exact-decimal primitive (`compareDecimal(value, "0")` behind a total wrapper) so accepted text cannot later fail merely because its exponent exceeds the arithmetic bound. `Number(value) > 0` is rejected as an alternative because it loses exactness and accepts forms outside the repository's exact-decimal contract.

### 5. Query fresh on every supported provider call

The provider contains no cache map and calls `getOrderPriceLimit` exactly once per supported invocation. These limits move with market conditions, unlike tick and quantity rules; returning a stale value would undermine the capability's meaning as a current snapshot.

A very short coalescing/cache window may be evaluated by a future change only if a measured call-volume or rate-limit problem justifies explicit staleness semantics. It is not part of V1.

### 6. Keep the capability foundation-only

This change adds the exchange capability and focused tests but does not construct or inject the provider in `server.ts`, expose it through HTTP, or call it from protection/runtime code. That makes the change independently reviewable and prevents an otherwise generic exchange read from silently acquiring Change 7 policy.

## Risks / Trade-offs

- [A fresh call per request adds latency and consumes one market-data request] → Keep the capability narrow; add caching only in a separately specified change with explicit staleness bounds if measurements require it.
- [Bybit changes the endpoint envelope or field representation] → Strict decoding returns `protocol_failure`; no guessed value reaches callers.
- [The requested category is not echoed by Bybit] → Support only literal `linear`, send it explicitly, and exact-match `symbol`; do not claim stronger response attribution than the API exposes.
- [A future consumer mistakes buy/sell limits for long/short policy] → Keep names aligned with Bybit and exclude side mapping from types, provider, tests, and this change's dependency graph.

## Migration Plan

This is additive and has no production consumer, durable data, configuration, or public API. Deployment and rollback consist only of adding or removing the isolated module, adapter primitive, fake support, and tests; existing runtime behavior remains unchanged.
