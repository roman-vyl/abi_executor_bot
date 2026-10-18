## ADDED Requirements

### Requirement: A position_open recovery response identifies the entry order whose fill ABI proved
The recovery-state success object SHALL additionally contain exactly two keys, `entry_order_link_id` and `entry_order_id`, each a non-empty JSON string or `null`. For `position_open`, `entry_order_link_id` SHALL be the current binding's `orderLinkId` that the recovery resolution queried, and `entry_order_id` SHALL be the `orderId` of the order row matched by that `orderLinkId` behind the resolved fill signal, or `null` when that row had no usable `orderId`. For every other `recovery_state`, both keys SHALL be `null`. Carrying the identifiers SHALL NOT add an exchange request, change the resolved state, or change convergence; convergence SHALL NOT write the row's `orderId` into the correlation record.

#### Scenario: position_open recovery names the proven order
- **WHEN** ABI resolves `position_open` from a row of this cycle's own entry order showing a fill
- **THEN** the response carries `entry_order_link_id` equal to the queried `orderLinkId` and `entry_order_id` equal to that row's `orderId`

#### Scenario: Recovery row without an order id
- **WHEN** ABI resolves `position_open` and the row has no usable `orderId`
- **THEN** `entry_order_id` is `null` and the rest of the response is unchanged

#### Scenario: Other recovery states
- **WHEN** ABI resolves `entry_order_live`, `entry_order_not_found`, `terminal_without_fill` or `terminal_after_fill`
- **THEN** both `entry_order_link_id` and `entry_order_id` are `null`
