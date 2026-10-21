## ADDED Requirements

### Requirement: Applied response identifies the cycle's own entry order

The `entry_package_applied` response MUST include `order_link_id` and `order_id` of the requested trade cycle's own entry order, taken from the confirmation read-back row of that order, and MUST NOT take `order_id` from the create response or add a Bybit request to obtain them. A field that the read-back did not provide MUST be omitted, and a missing or invalid `orderId` MUST NOT change the confirmation outcome.

#### Scenario: First apply
- **WHEN** ABI creates the entry order and confirms it by read-back
- **THEN** the response carries the read-back row's `orderLinkId` and `orderId`

#### Scenario: Create response lost, repeat PUT confirms
- **WHEN** the create response did not provide an order id and a repeat PUT confirms the order by read-back
- **THEN** the response carries the read-back row's `orderId`

#### Scenario: Already filled order
- **WHEN** the confirmation read finds the cycle's own entry order filled
- **THEN** the response carries that order's `orderLinkId` and `orderId`

#### Scenario: Bybit row without order id
- **WHEN** the read-back row has no usable `orderId`
- **THEN** `order_id` is omitted and the apply outcome is the same as before

#### Scenario: Apply is not confirmed
- **WHEN** the apply ends as terminal without fill, not found, or ambiguous
- **THEN** the response is unchanged `internal_error` with neither field
