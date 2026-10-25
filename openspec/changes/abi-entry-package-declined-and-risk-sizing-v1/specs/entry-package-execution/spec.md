## MODIFIED Requirements

### Requirement: Calculated quantity is genuinely executable on the exchange, not a hardcoded value
In `minimum` sizing mode ABI SHALL calculate an order quantity that satisfies the exchange's minimum order
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
- **WHEN** `ABI_POSITION_SIZING_MODE` is `minimum` and an entry-package command includes a positive risk multiplier
- **THEN** ABI SHALL accept it and pass it through the sizing calculation without
  rejecting the request, and the minimum formula SHALL NOT vary the result by that value

#### Scenario: A structurally malformed trading-rules response is never used for sizing
- **WHEN** a `linear`-category `instruments-info` lookup returns a response that is not
  an object, whose `result` is not an object, whose `result.category` does not match the
  requested category, whose `result.list` is not an array, whose `result.list` does not
  contain exactly one row, whose row is not an object, whose row's `symbol` does not
  match the requested symbol, or whose row is missing an object `lotSizeFilter`
- **THEN** ABI SHALL NOT calculate a quantity from that response, SHALL NOT cache it, and
  SHALL return a safe internal error instead of submitting an order

#### Scenario: Trading-rules fields with invalid sign, malformed decimal text, or an unsupported exponent are never used for sizing
- **WHEN** a `linear`-category `instruments-info` lookup's `lotSizeFilter` has a
  `minOrderQty` or `qtyStep` that is not strictly positive exact-decimal text usable by
  ABI's sizing arithmetic (zero, negative, a non-string, malformed text, or text whose
  exponent exceeds the arithmetic parser's supported range), or a `minNotionalValue`
  that is negative, not exact-decimal text, or similarly out of the arithmetic parser's
  supported range
- **THEN** ABI SHALL NOT calculate a quantity from that response, SHALL NOT cache it, and
  SHALL return a safe internal error instead of submitting an order

#### Scenario: A `spot`-category trading-rules lookup is unsupported and fails closed
- **WHEN** ABI requests trading rules for a `spot`-category instrument
- **THEN** ABI SHALL NOT attempt to interpret a `linear`-shaped `lotSizeFilter` from that
  response, SHALL NOT calculate a quantity or cache a result, and SHALL return a safe
  internal error, since `spot`'s trading-rules schema is not supported for sizing in this
  capability

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

## ADDED Requirements

### Requirement: Sizing mode is chosen by configuration independent of the environment
ABI SHALL read `ABI_POSITION_SIZING_MODE` with values `minimum` (default when
unset) and `risk`, independent of `BYBIT_ENV`.

#### Scenario: Default mode
- **WHEN** `ABI_POSITION_SIZING_MODE` is unset
- **THEN** ABI sizes in `minimum` mode exactly as before this change

#### Scenario: Invalid mode
- **WHEN** the value is neither `minimum` nor `risk`
- **THEN** ABI fails startup

#### Scenario: Risk mode needs credentials
- **WHEN** the mode is `risk` and `BYBIT_API_KEY` or `BYBIT_API_SECRET` is empty
- **THEN** ABI fails startup, also when `ABI_DRY_RUN` is true

#### Scenario: Environment guard unchanged
- **WHEN** the mode is `risk` and `BYBIT_ENV` is `mainnet`
- **THEN** the existing live guard still blocks every exchange write

#### Scenario: Mode is visible at startup
- **WHEN** ABI starts
- **THEN** the `service_starting` event carries the sizing mode

### Requirement: Risk mode sizes from the wallet balance and the risk percent
In `risk` mode ABI SHALL compute `quantity = (totalWalletBalance × risk_multiplier / 100) / |planned_entry_price − initial_stop_price|`
in exact decimals, rounded down to `qtyStep`, with no fees or slippage, reading
the balance on every calculation without a cache.

#### Scenario: Risk multiplier is the percent
- **WHEN** `totalWalletBalance` is `10000`, `risk_multiplier` is `1`, the distance is `100`, and `qtyStep` is `0.001`
- **THEN** the quantity is `1.000`
- **AND** with `risk_multiplier` `0.5` it is `0.500` and with `2` it is `2.000`

#### Scenario: Rounding is down
- **WHEN** the exact ratio is not a multiple of `qtyStep`
- **THEN** the quantity is the largest multiple of `qtyStep` not above the ratio

#### Scenario: No ABI risk settings
- **WHEN** ABI sizes in `risk` mode
- **THEN** no base percent, maximum percent, or coefficient from ABI configuration changes the result

#### Scenario: Leverage untouched
- **WHEN** ABI sizes or submits an entry in either mode
- **THEN** ABI neither reads nor sets leverage

### Requirement: Risk mode uses account-wide balance only where Bybit defines it
Before reading the balance, ABI SHALL read `marginMode` from `GET /v5/account/info`
on every calculation and SHALL size only for `REGULAR_MARGIN` or
`PORTFOLIO_MARGIN`.

#### Scenario: Isolated margin
- **WHEN** `marginMode` is `ISOLATED_MARGIN`
- **THEN** ABI declines with `margin_mode_not_supported`
- **AND** ABI does not use a per-coin balance instead

#### Scenario: Unknown margin mode
- **WHEN** `marginMode` is any other value
- **THEN** ABI declines with `margin_mode_not_supported`

#### Scenario: Non-positive balance
- **WHEN** `totalWalletBalance` is exact-decimal text not above zero
- **THEN** ABI declines with `insufficient_balance_for_minimum_quantity`

### Requirement: Predictable refusals in risk mode are declined
In `risk` mode ABI SHALL decline, without contacting the exchange for a write,
when the stop distance is invalid, the margin mode is unsupported, or the
rounded quantity does not meet the exchange limits. ABI SHALL NOT raise the
quantity to the exchange minimum or replace the requested risk.

#### Scenario: Invalid stop distance
- **WHEN** the stop equals the entry, or is at or above the entry for a long, or at or below the entry for a short
- **THEN** ABI declines with `invalid_stop_distance` before any exchange read

#### Scenario: Below exchange minimum
- **WHEN** the rounded quantity is zero, below `minOrderQty`, or its value at `planned_entry_price` is below `minNotionalValue`
- **THEN** ABI declines with `insufficient_balance_for_minimum_quantity`

#### Scenario: Above exchange maximum
- **WHEN** the rounded quantity is above `maxMktOrderQty`
- **THEN** ABI declines with `quantity_above_exchange_maximum`

#### Scenario: Read failure is not a refusal
- **WHEN** the account-info, wallet-balance, or trading-rules read times out, fails, returns `retCode` other than zero, or returns a malformed or missing value
- **THEN** ABI does not decline and follows the existing pre-boundary failure rule (`absent`, `500 internal_error`)

### Requirement: A declined first APPLY is durably closed before the answer
ABI SHALL answer `entry_package_declined` only for a pair whose record is still
`admission_pending`, after durably moving it to `absent` with the existing
conditional transition and emitting the operational event
`entry_package_declined`.

#### Scenario: Declined first APPLY
- **WHEN** the calculator declines on a first non-null PUT
- **THEN** the record is durably `absent`, the event carries the reason, and the response is `200 entry_package_declined`
- **AND** no scope is claimed and no exchange write is sent
- **AND** a later recovery-state query for the pair resolves `terminal_without_fill`

#### Scenario: Absent write fails
- **WHEN** the transition to `absent` fails
- **THEN** ABI responds `500 internal_error` and the record stays `admission_pending`

#### Scenario: Decline on a retry of an existing record
- **WHEN** the calculator declines inside a create for a pair whose record is not `admission_pending`
- **THEN** ABI responds `500 internal_error` as for a quantity-calculation failure

#### Scenario: Minimum mode never declines
- **WHEN** the mode is `minimum`
- **THEN** ABI never returns `entry_package_declined`
