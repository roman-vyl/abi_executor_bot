## Purpose

Provide a fresh, strictly validated snapshot of Bybit's current permissible order-price band for one explicitly requested linear instrument, without embedding any trading or protection policy.

## ADDED Requirements

### Requirement: A lookup is explicitly scoped to category and symbol
The capability SHALL require both `category` and `symbol` on every lookup, SHALL pass both values to the exchange transport boundary without guessing or substituting an instrument, and SHALL support only `category: "linear"` in V1.

#### Scenario: A linear instrument is queried with both identity fields
- **WHEN** a caller requests current order-price limits with `category: "linear"` and a symbol
- **THEN** ABI queries the exchange using that exact category and symbol

#### Scenario: An unsupported category fails before exchange access
- **WHEN** a caller requests current order-price limits for any category other than `linear`
- **THEN** ABI returns a typed `unsupported_category` failure
- **AND** ABI does not call the exchange adapter

### Requirement: A valid response produces an exact current snapshot
For a successful linear lookup, ABI SHALL return a typed success containing the exchange's positive exact-decimal `buyLmt` and `sellLmt` strings unchanged as `buyLimit` and `sellLimit`, and SHALL convert the response's valid integer-millisecond `result.ts` to a safe integer `observedAtMs`.

#### Scenario: A valid linear response succeeds
- **WHEN** Bybit returns a valid success envelope whose `result.symbol` exactly matches the requested symbol, whose `buyLmt` and `sellLmt` are positive exact-decimal strings, and whose `result.ts` is a valid positive safe-integer millisecond string
- **THEN** ABI returns `{ kind: "success", limits: { buyLimit, sellLimit, observedAtMs } }`
- **AND** `buyLimit` and `sellLimit` preserve the exchange strings without numeric coercion or rounding
- **AND** `observedAtMs` is derived from `result.ts`, not from the local clock

### Requirement: The endpoint response is decoded strictly and fails closed
ABI SHALL accept only a structurally valid Bybit success envelope with `retCode: 0`, a string `retMsg`, a positive safe-integer envelope `time`, an object `result`, an exact symbol match, positive exact-decimal string limits, and a positive safe-integer millisecond `result.ts`. Missing, malformed, non-positive, identity-mismatched, or arithmetic-unsafe values SHALL return a typed protocol failure and SHALL NOT produce guessed or fallback limits.

#### Scenario: The Bybit envelope is malformed
- **WHEN** the response is not an object, has a non-zero or malformed `retCode`, lacks a string `retMsg`, has a malformed envelope `time`, or does not contain an object `result`
- **THEN** ABI returns a typed `protocol_failure` identifying a malformed envelope
- **AND** ABI returns no limits snapshot

#### Scenario: The returned symbol does not exactly match
- **WHEN** `result.symbol` is missing, malformed, or differs from the requested symbol
- **THEN** ABI returns a typed `protocol_failure` identifying a symbol mismatch
- **AND** ABI does not accept another instrument's limits

#### Scenario: buyLmt is missing or malformed
- **WHEN** `result.buyLmt` is missing, is not a string, or is not an arithmetic-safe exact-decimal string
- **THEN** ABI returns a typed `protocol_failure` identifying an invalid buy limit

#### Scenario: sellLmt is missing or malformed
- **WHEN** `result.sellLmt` is missing, is not a string, or is not an arithmetic-safe exact-decimal string
- **THEN** ABI returns a typed `protocol_failure` identifying an invalid sell limit

#### Scenario: Either limit is zero or negative
- **WHEN** either decoded limit is zero or negative
- **THEN** ABI returns the typed protocol failure for that invalid limit
- **AND** ABI returns no limits snapshot

#### Scenario: The observation timestamp is malformed
- **WHEN** `result.ts` is missing, is not a string containing a canonical positive integer, or cannot be represented as a safe integer
- **THEN** ABI returns a typed `protocol_failure` identifying an invalid timestamp
- **AND** ABI does not substitute the envelope time or local clock

### Requirement: Transport failures remain typed
The provider SHALL convert an adapter rejection, timeout, network failure, non-success HTTP result, or exchange rejection surfaced by the adapter into a typed `transport_failure` and SHALL NOT throw that failure through its result contract or fabricate a protocol result.

#### Scenario: Adapter transport fails
- **WHEN** the exchange adapter cannot complete the order-price-limit request
- **THEN** ABI returns `{ kind: "failure", failure: { kind: "transport_failure" } }`
- **AND** ABI returns no limits snapshot

### Requirement: Every provider request reads a fresh exchange snapshot
The provider SHALL call the exchange adapter once for every supported lookup invocation and SHALL NOT use durable caching or a long-lived in-memory cache for current order-price limits.

#### Scenario: Repeated lookup calls query Bybit repeatedly
- **WHEN** the provider receives two sequential supported requests for the same category and symbol
- **THEN** it calls the exchange adapter once for each request
- **AND** the second result is decoded from the second response rather than reused from the first

### Requirement: The capability contains no business or protection policy
The capability SHALL expose only the validated exchange snapshot and typed query failures. It SHALL NOT map position side to either limit, calculate surrogate prices, clamp a desired price, interpret TP/SL or protection state, amend orders, persist state, retry, or expose a public HTTP route.

#### Scenario: A caller receives raw validated band semantics only
- **WHEN** a valid limits snapshot is returned
- **THEN** ABI identifies the values only as `buyLimit` and `sellLimit`
- **AND** the capability makes no assertion about which value any strategy, position side, order intent, or protection operation should use

### Requirement: Dynamic price limits remain separate from instrument trading rules
ABI SHALL model the current `buyLmt`/`sellLmt` market snapshot as a separate capability from `InstrumentTradingRules`, whose tick, static price-filter, quantity, and notional constraints have different freshness and caching semantics.

#### Scenario: Reading current limits does not read or mutate trading-rules state
- **WHEN** current order-price limits are requested
- **THEN** ABI does not call the instrument-trading-rules provider
- **AND** it does not read, populate, invalidate, or otherwise change that provider's cache
