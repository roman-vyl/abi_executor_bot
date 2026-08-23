## Why

A real Bybit Demo create proved that Bybit accepts raw Strategy Engine decimal text and then returns its own canonical exchange representation for trigger, stop, and take prices. Requiring exact equality between those two representations makes a successfully accepted, correctly identified order falsely ambiguous.

## What Changes

- Confirm a successful create or amend from the accepted write plus a bounded read-back of the same exchange order with strict identity, recognized state, matching quantity, and structurally valid exchange-reported numeric fields.
- Treat Bybit's read-back trigger, stop, and take prices as authoritative exchange representation rather than requiring equality with raw desired-entry decimal text.
- Preserve fail-closed behavior for identity, quantity, state, malformed response, and query failures.
- Apply the same confirmation model to repeat PUT and metadata-only revalidation.
- Do not add tick-size logic, rounding, truncation, tolerance, floating-point conversion, or any parallel prediction of Bybit's canonical prices.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `entry-package-execution`: Replace raw desired-price equality confirmation with authoritative same-order exchange read-back semantics while retaining strict identity, quantity, state, and structural validation.

## Impact

- Affects entry-package create, amend, repeat PUT, and metadata-only confirmation in `src/services/entryPackage` and focused unit tests.
- Does not change Runtime, Strategy Engine, public HTTP APIs, correlation record shape, sizing, idempotency, recovery, or live-execution guards.
- Demo/testnet live writes retain the existing safety gate; mainnet remains blocked and dry-run behavior is unchanged.
