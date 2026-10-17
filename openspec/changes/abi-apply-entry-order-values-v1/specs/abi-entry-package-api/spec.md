## ADDED Requirements

### Requirement: Applied response reports four values of the cycle's own entry order

The `entry_package_applied` response MUST include `planned_entry_price`, `stop_loss`,
`take_profit` and `quantity` of the requested trade cycle's own entry order as read back
from Bybit during the apply, and MUST NOT take any of them from Bybit's aggregated
position or add a Bybit request to obtain them.

#### Scenario: Pending entry order
- **WHEN** ABI confirms the cycle's own entry order live
- **THEN** the response carries that order's entry price, stop-loss, take-profit and quantity as read back

#### Scenario: Aggregated position differs
- **WHEN** Bybit's aggregated position for the symbol has a different size, stop-loss or take-profit than the cycle's own order
- **THEN** none of those aggregated values appears in the response

#### Scenario: Bybit reports no stop-loss or take-profit
- **WHEN** the order read has an empty or zero stop-loss or take-profit
- **THEN** that field is `null`

#### Scenario: Apply is not confirmed
- **WHEN** the apply ends as terminal without fill, not found, or ambiguous
- **THEN** the response is unchanged `internal_error` with none of the four fields
