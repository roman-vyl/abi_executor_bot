## MODIFIED Requirements

### Requirement: Calculated quantity is genuinely executable on the exchange, not a hardcoded value
ABI SHALL calculate an order quantity that satisfies the exchange's minimum order
quantity, quantity step, and minimum notional value for the traded instrument.

#### Scenario: Minimum quantity satisfies exchange minimum order size
- **WHEN** ABI calculates the quantity for an entry package
- **THEN** the calculated quantity SHALL be at or above the exchange's minimum order
  quantity for that instrument, rounded to its quantity step

#### Scenario: Minimum quantity satisfies exchange minimum notional value
- **WHEN** the exchange's minimum order quantity alone would produce an order value below
  the exchange's minimum notional value for that instrument
- **THEN** ABI SHALL increase the calculated quantity so the resulting order value meets
  the minimum notional value, rounded to the quantity step

#### Scenario: Sizing accepts but does not yet apply risk multiplier
- **WHEN** an entry-package command includes a positive risk multiplier
- **THEN** ABI SHALL accept it and pass it through the sizing calculation without
  rejecting the request, even though the current sizing formula does not yet vary the
  result by that value

#### Scenario: A structurally malformed trading-rules response is never used for sizing
- **WHEN** an `instruments-info` lookup returns a response that is not an object, whose
  `result` is not an object, whose `result.category` does not match the requested
  category, whose `result.list` is not an array, whose `result.list` does not contain
  exactly one row, whose row is not an object, whose row's `symbol` does not match the
  requested symbol, or whose row is missing an object `lotSizeFilter`
- **THEN** ABI SHALL NOT calculate a quantity from that response, SHALL NOT cache it, and
  SHALL return a safe internal error instead of submitting an order

#### Scenario: Trading-rules fields with invalid sign or malformed decimal text are never used for sizing
- **WHEN** an `instruments-info` lookup's `lotSizeFilter` has a `minOrderQty` or
  `qtyStep` that is not strictly positive exact-decimal text (zero, negative, a
  non-string, or malformed/exponent text), or a `minNotionalValue` that is negative or
  not exact-decimal text
- **THEN** ABI SHALL NOT calculate a quantity from that response, SHALL NOT cache it, and
  SHALL return a safe internal error instead of submitting an order

#### Scenario: A zero minimum notional value is a valid trading rule
- **WHEN** an `instruments-info` lookup's `lotSizeFilter.minNotionalValue` is exactly
  `"0"`
- **THEN** ABI SHALL treat this as a valid trading rule and size the order from
  `minOrderQty` alone, unchanged from the existing sizing formula

#### Scenario: A rejected trading-rules response does not poison the cache
- **WHEN** ABI rejects an `instruments-info` response for a given category and symbol as
  malformed or identity-mismatched
- **THEN** ABI SHALL NOT store that response's values in the trading-rules cache, and the
  next lookup for the same category and symbol SHALL query the exchange again rather than
  reuse a prior failed result
