## ADDED Requirements

### Requirement: The entry order identifiers come only from the proof's own order identity
For an open result, ABI SHALL take `entry_order_link_id` from the current binding's `order_link_id`, the identity the fill proof used for its order read and for the `first_fill_at_ms` execution query, and never from `binding_history`. ABI SHALL take `entry_order_id` only from a Bybit order row matched by that `orderLinkId`:

- on the fresh path, from the `orderId` of the row whose read produced the open result;
- on the reuse path (a final stored `early_execution_observation`), from the observation's `order_id`, which the apply-time confirmation writes from the `orderId` of the same row the observation is built from;
- `null` when that row had no usable `orderId`, or the stored observation has no `order_id`.

ABI SHALL NOT use the correlation record's `order_id` captured from the create acknowledgement, SHALL NOT issue an additional exchange request to obtain an identifier, and SHALL NOT change how `position_open`, `average_entry_price`, `first_fill_at_ms` or any partial-fill outcome is determined. An observation without the `order_id` key SHALL be read as `order_id: null`, and no stored record SHALL be rewritten for this.

#### Scenario: Fresh path
- **WHEN** the stored observation is `null` or not final, and the fresh read of this cycle's own entry order shows a fill
- **THEN** `entry_order_id` is that row's `orderId`, or `null` if the row has none

#### Scenario: Entry filled at placement
- **WHEN** the apply-time confirmation found this cycle's own entry order filled and stored a final observation with `order_id`
- **THEN** a later lookup reuses the observation without an exchange call and returns that `order_id` as `entry_order_id`

#### Scenario: Stored observation without an order id
- **WHEN** the reused final observation has no `order_id`
- **THEN** `entry_order_id` is `null`, no exchange call is made for it, and the create-acknowledgement `order_id` is not returned

#### Scenario: Partial fill
- **WHEN** this cycle's own entry order is partially filled and still live
- **THEN** the result is open exactly as before, and the identifiers name that same order
