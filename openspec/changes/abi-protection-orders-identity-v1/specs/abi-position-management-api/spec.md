## MODIFIED Requirements

### Requirement: Protection success is a closed object, confirmed by exact numeric equality
A successful response SHALL be HTTP `200` with a closed JSON object containing exactly `strategy_instance_id`, `trade_cycle_id`, `status: "protection_applied"`, `stop_price`, `take_price` (`take_price` `null` when the request's `take_price` was `null`), and `protection_orders`. `protection_orders` SHALL be a closed object with exactly `quantity`, `stop` and `take`: `quantity` SHALL be the position quantity both protective legs carry (positive exact decimal string, Bybit `qty`, equal on both legs); `stop` and `take` SHALL each be a closed object with exactly `order_id` (non-empty string) and `trigger_price` (positive exact decimal string), taken unchanged from the Bybit `orderId` and `triggerPrice` of the attributed protective child read that proved this success; `take` SHALL be present even when `take_price` is `null`. `protection_applied` SHALL be returned only once ABI has verified, via exact-decimal numeric comparison, that the exchange's confirmed protection equals the requested `stop_price`/`take_price` — string formatting differences (e.g. trailing zeros) SHALL NOT block confirmation, but any genuine numeric difference SHALL. An exchange acknowledgement that a write was accepted, submitted, or queued SHALL NOT by itself satisfy this requirement. ABI SHALL NOT canonicalize, reformat, or otherwise alter the accepted request values: the response SHALL return the exact `stop_price`/`take_price` strings ABI accepted in the request, unchanged. When the exchange's confirmed protection already numerically equals the requested values before any write, ABI SHALL return `protection_applied` without sending an exchange write.

#### Scenario: Verified protection returns the accepted request strings unchanged
- **WHEN** the exchange's confirmed stop/take are numerically equal to the requested values
- **THEN** ABI returns HTTP `200` with `status: "protection_applied"` and the exact `stop_price`/`take_price` strings it accepted in the request

#### Scenario: Response object is closed, with take_price nulled through
- **WHEN** ABI returns `protection_applied`
- **THEN** the response contains exactly `strategy_instance_id`, `trade_cycle_id`, `status`, `stop_price`, `take_price`, and `protection_orders`, with no additional fields
- **AND** `take_price` is `null` when the request's `take_price` was `null`

#### Scenario: Exchange-normalized value blocks success
- **WHEN** the exchange's confirmed stop or take is numerically different from the requested value (e.g. adjusted to a tick size)
- **THEN** ABI does not return `protection_applied` or any other `2xx`

#### Scenario: Accepted-but-unverified write is not acknowledged
- **WHEN** the exchange has accepted, submitted, or queued the write but ABI has not verified it
- **THEN** ABI does not return `protection_applied` or any other `2xx`

#### Scenario: Already-matching confirmed protection may return protection_applied without exchange mutation
- **WHEN** the exchange's confirmed stop/take already numerically equal the requested values before ABI sends any write
- **THEN** ABI returns HTTP `200` with `status: "protection_applied"` and the exact `stop_price`/`take_price` strings it accepted in the request, having sent no exchange write

#### Scenario: Protective orders come from the proving read
- **WHEN** ABI returns `protection_applied` after a write
- **THEN** `protection_orders.stop` and `protection_orders.take` carry the `orderId` and `triggerPrice` of the post-write read-back legs, and `protection_orders.quantity` their common `qty`, as Bybit returned them

#### Scenario: Protective orders on an already-satisfied state
- **WHEN** ABI returns `protection_applied` without a write
- **THEN** `protection_orders` carries the legs of the read that matched

#### Scenario: Disabled take still reports the surrogate take order
- **WHEN** the request's `take_price` is `null`
- **THEN** the response has `take_price: null` and `protection_orders.take` describing the surrogate take order
