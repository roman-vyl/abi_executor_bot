# exchange-instrument-identity Specification

## Purpose

Defines ABI's deterministic, local resolution of a Runtime ticker into the Bybit
exchange instrument identity (symbol, category, and product) that the entry-package
contour needs to build a correct exchange call.

## Requirements

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

### Requirement: The ticker must match one of exactly two grammars, or resolution fails closed
ABI SHALL accept only a ticker matching one of exactly two shapes:

- `[A-Z0-9]+` — a bare symbol, resolving to `category: spot`, `product: spot`, with
  `symbol` equal to the ticker unchanged;
- `[A-Z0-9]+\.P` — a symbol followed by the exact trailing suffix `.P`, resolving to
  `category: linear`, `product: perpetual`, with `symbol` equal to the ticker with the
  trailing `.P` removed.

Any ticker that matches neither shape SHALL be rejected with a typed resolver error
rather than being resolved to a best-guess `symbol`/`category`.

#### Scenario: Bare uppercase-alphanumeric ticker resolves to spot
- **WHEN** the ticker is `BTCUSDT`
- **THEN** ABI resolves `{ symbol: "BTCUSDT", category: "spot", product: "spot" }`

#### Scenario: Uppercase-alphanumeric ticker with trailing `.P` resolves to linear perpetual
- **WHEN** the ticker is `BTCUSDT.P`
- **THEN** ABI resolves `{ symbol: "BTCUSDT", category: "linear", product: "perpetual" }`

#### Scenario: Trailing extra characters after `.P` are rejected
- **WHEN** the ticker is `BTCUSDT.PX`
- **THEN** ABI SHALL raise a typed resolver error and SHALL NOT resolve it as spot or as
  any other identity

#### Scenario: A second `.`-delimited segment is rejected
- **WHEN** the ticker is `BTC.USDT`
- **THEN** ABI SHALL raise a typed resolver error

#### Scenario: Whitespace within the ticker is rejected
- **WHEN** the ticker is `BTC USDT`
- **THEN** ABI SHALL raise a typed resolver error

### Requirement: Resolution is deterministic, local, and rejects degenerate input
Resolution SHALL be a pure function of the ticker's text with no network or other I/O,
returning the identical result for the same input every time. A degenerate ticker —
empty, or one that is only the `.P` suffix with no symbol text before it — SHALL be
rejected with a typed error rather than producing a partial or guessed identity.

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
