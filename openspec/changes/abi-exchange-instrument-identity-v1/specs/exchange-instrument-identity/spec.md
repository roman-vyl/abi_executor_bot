## Purpose

Defines ABI's deterministic, local resolution of a Runtime ticker into the Bybit
exchange instrument identity (symbol, category, and product) that the entry-package
contour needs to build a correct exchange call, replacing the temporary bare-string
`resolveSymbol` placeholder.

## ADDED Requirements

### Requirement: Resolving a ticker produces a full exchange instrument identity
ABI SHALL resolve a Runtime `ticker` into an `ExchangeInstrumentIdentity` containing the
original `ticker`, the derived Bybit `symbol`, the Bybit `category`, and the `product`
semantics of the instrument.

#### Scenario: Resolving a perpetual ticker
- **WHEN** the ticker is `BTCUSDT.P`
- **THEN** ABI resolves `{ ticker: "BTCUSDT.P", symbol: "BTCUSDT", category: "linear",
  product: "perpetual" }`

#### Scenario: Resolving a spot ticker
- **WHEN** the ticker is `BTCUSDT`
- **THEN** ABI resolves `{ ticker: "BTCUSDT", symbol: "BTCUSDT", category: "spot",
  product: "spot" }`

#### Scenario: A second perpetual ticker resolves the same way
- **WHEN** the ticker is `ETHUSDT.P`
- **THEN** ABI resolves `{ ticker: "ETHUSDT.P", symbol: "ETHUSDT", category: "linear",
  product: "perpetual" }`

### Requirement: A trailing `.P` suffix, and only a trailing suffix, selects linear/perpetual
ABI SHALL recognize `.P` as the perpetual marker only when it is the exact trailing
characters of the ticker, stripping it to produce `symbol`. A ticker that does not end in
`.P` SHALL resolve to `category: spot`, `product: spot`, with `symbol` equal to the
ticker unchanged.

#### Scenario: Non-trailing `.P` does not select linear
- **WHEN** the ticker contains `.P` somewhere other than as its final two characters
  (e.g. `BTCUSDT.PX`)
- **THEN** ABI SHALL NOT treat it as the perpetual suffix and SHALL resolve it via the
  spot branch, with `symbol` equal to the full ticker text

### Requirement: Resolution is deterministic, local, and rejects degenerate input
Resolution SHALL be a pure function of the ticker's text with no network or other I/O,
returning the identical result for the same input every time. A degenerate ticker — empty,
or one that strips to an empty symbol — SHALL be rejected with a typed error rather than
producing a partial or guessed identity.

#### Scenario: Empty ticker is rejected
- **WHEN** the ticker is an empty string
- **THEN** ABI SHALL raise a typed resolver error and SHALL NOT return an identity

#### Scenario: Suffix-only ticker is rejected
- **WHEN** the ticker is exactly `.P`
- **THEN** ABI SHALL raise a typed resolver error and SHALL NOT return an identity

#### Scenario: Resolution performs no I/O
- **WHEN** ABI resolves any ticker
- **THEN** resolution SHALL complete without any network call, and SHALL NOT confirm
  whether the resulting instrument actually exists on Bybit
