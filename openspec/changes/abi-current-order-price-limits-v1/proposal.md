## Why

Bybit's current permissible order-price band is market-dependent and exposed separately from the slow-moving instrument constraints ABI already reads. ABI needs a small fail-closed exchange capability that can obtain and validate that current snapshot before later changes make any trading decision from it, without coupling the read boundary to protection or strategy semantics.

## What Changes

- Add a generic current order-price-limits provider for Bybit `GET /v5/market/price-limit`, explicitly scoped by `category` and `symbol`.
- Support only `category: "linear"` in V1; every other category returns a typed unsupported failure without calling Bybit.
- Add a strict endpoint-specific decoder for the Bybit success envelope and `result.symbol`, positive exact-decimal `buyLmt`/`sellLmt`, and integer-millisecond `result.ts`; malformed, missing, or identity-mismatched data fails closed with no fallback values.
- Return a typed success snapshot containing `buyLimit`, `sellLimit`, and `observedAtMs`, or a typed failure that distinguishes unsupported input, transport failure, and protocol/decode failure.
- Read the market-dependent limits fresh on every provider request. No durable or long-lived in-memory cache, retries, persistence, or surrogate calculation is introduced.
- Keep the capability separate from `InstrumentTradingRules`: existing tick, static price-filter, quantity, and notional constraints retain their current provider and cache behavior.
- Add only the Bybit adapter transport primitive needed to issue the public market query; response semantics remain in the dedicated decoder/provider module.
- Add focused unit tests for valid data, every required malformed field class, transport failure, unsupported category, and fresh-call behavior.

Explicit non-goals are strategy or side mapping, trade-cycle semantics, protection/TP/SL behavior, surrogate TAKE formulas, price clamping, amend logic, retries, persistence, HTTP routes, Runtime integration, and any consumer wiring.

## Capabilities

### New Capabilities

- `order-price-limits`: provides a validated, fresh current Bybit order-price-band snapshot for one explicitly requested linear instrument, with typed fail-closed outcomes.

### Modified Capabilities

None.

## Impact

- Proposed implementation boundary: a compact `src/exchange/orderPriceLimits/` module containing endpoint-specific types, decoder, and provider, plus a transport-only `BybitAdapter.getOrderPriceLimit(category, symbol)` primitive and focused unit-test/fake support.
- No public HTTP API or existing application service changes; the capability is foundation-only and has no production consumer in this change.
- No changes to `InstrumentTradingRulesProvider`, sizing, `ProtectionApplicationService`, native protection attribution, `EntryPackageExecutionRecord`, correlation repositories, Runtime, or Change 7 artifacts.
- The capability performs a public market-data read only. It creates no order or position, has no idempotency or recovery state, writes no correlation data, and does not alter dry-run, Demo/Testnet execution gates, or the mainnet live guard.
