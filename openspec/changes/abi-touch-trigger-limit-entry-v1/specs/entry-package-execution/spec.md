## ADDED Requirements

### Requirement: touch_trigger limit entry is a plain GTC Limit order at the tick-aligned planned price
With `live_entry_mode = touch_trigger` and `touch_trigger_entry_order_type =
limit`, ABI SHALL create the entry as `orderType: Limit` with
`timeInForce: GTC` and a `price` equal to `planned_entry_price` aligned to the
instrument `tickSize`: unchanged when it is already a multiple of `tickSize`,
otherwise rounded up for a long and down for a short, with no further offset.
The request SHALL contain none of `triggerPrice`, `triggerDirection` or
`triggerBy`, and its other fields SHALL equal the `touch_trigger` + `market`
request for the same package. ABI SHALL obtain `tickSize` from the existing
instrument trading rules and SHALL resolve the price before its provisional
durable write and before any exchange call. ABI SHALL NOT use the market
price or order book to set or move the price, and SHALL NOT add timers,
re-placement or cancellation of its own.

#### Scenario: Price already on the tick grid
- **WHEN** a long or short package has `planned_entry_price` that is a
  multiple of `tickSize`
- **THEN** the Limit `price` equals `planned_entry_price` exactly

#### Scenario: Price off the grid
- **WHEN** `planned_entry_price` is not a multiple of `tickSize`
- **THEN** a long uses the next tick above and a short the next tick below

#### Scenario: Trading rules unavailable
- **WHEN** the trading rules lookup fails
- **THEN** no create request is sent and the attempt is closed as absent
  like any other failure before the exchange boundary

#### Scenario: Other modes unchanged
- **WHEN** the mode is `ema_anchor` or `touch_trigger` + `market`
- **THEN** ABI sends exactly the requests it sent before this change

### Requirement: A partially filled limit entry keeps its remainder live
ABI SHALL NOT cancel the remainder of a partially filled `touch_trigger`
limit entry on its own. A partial fill SHALL be confirmed and acknowledged
through the existing fill classification, the own filled quantity SHALL be
read from the entry order's `cumExecQty` while the order is live, and the
remainder SHALL end only by filling, by a Runtime `CANCEL`/`REPLACE` that
reaches ABI, or by close execution cancelling the live entry before closing.

#### Scenario: Partial fill acknowledged
- **WHEN** the Limit entry is `PartiallyFilled` at confirmation
- **THEN** ABI acknowledges `entry_package_applied`, records the observed
  filled quantity, and sends no cancel

#### Scenario: Later fill of the remainder
- **WHEN** more of the remainder fills after Runtime moved to position
  management
- **THEN** open-position, protection and close read the larger filled
  quantity from the entry order without any new record or route

### Requirement: V1 assumes one native protection pair per limit entry
For `touch_trigger` limit entries ABI SHALL keep the existing attribution of
exactly one `PartialStopLoss` and one `PartialTakeProfit` child per parent
`orderLinkId`. More than one child of a role SHALL remain an ambiguous
attribution on which protection changes fail closed. This is a documented
limitation: Bybit's behaviour for several fills of one parent is not
established.

#### Scenario: Several children of one role
- **WHEN** a limit entry has two `PartialStopLoss` children
- **THEN** a protection change for that cycle fails closed and no amend is
  sent
