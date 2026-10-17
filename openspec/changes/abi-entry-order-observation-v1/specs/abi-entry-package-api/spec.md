## ADDED Requirements

### Requirement: Applied response reports the cycle's own physical entry order

The entry-package applied response MUST include an optional `cycle_execution_state`
whose `entry_order` describes the entry order of the requested
`(strategy_instance_id, trade_cycle_id)` as read back from Bybit, and MUST NOT take
any value of it from Bybit's aggregated position.

#### Scenario: Pending entry order
- **WHEN** ABI confirms the cycle's own entry order live and unfilled
- **THEN** `cycle_execution_state.entry_order` carries that order's `order_id`, `side`, `trigger_price`, `quantity`, `order_status`, `stop_loss` and `take_profit` as read back
- **AND** `executed_quantity` and `average_entry_price` are absent

#### Scenario: Already filled at response time
- **WHEN** the cycle's own entry order has strictly positive executed quantity when ABI builds the response
- **THEN** `executed_quantity` and `average_entry_price` are present and come from that order only

#### Scenario: Aggregate position differs
- **WHEN** Bybit's aggregated position for the symbol is larger than the cycle's own order
- **THEN** no value in the response reflects the aggregate

#### Scenario: Value not provided by the read
- **WHEN** Bybit reports no stop-loss or take-profit for the order
- **THEN** the corresponding field is `null`
