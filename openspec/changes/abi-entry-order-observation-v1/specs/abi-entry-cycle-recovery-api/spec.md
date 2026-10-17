## ADDED Requirements

### Requirement: Recovery states report the cycle's own physical entry order

The `entry_order_live` and `position_open` recovery-state responses MUST include an
optional `cycle_execution_state` built only from the cycle's own entry order, with
the same shape and attribution rule as the entry-package applied response, and MUST
NOT issue an additional Bybit request for it.

#### Scenario: entry_order_live
- **WHEN** recovery resolves `entry_order_live`
- **THEN** `cycle_execution_state.entry_order` is present and `executed_quantity` is absent

#### Scenario: position_open
- **WHEN** recovery resolves `position_open`
- **THEN** `cycle_execution_state` carries `executed_quantity` and `average_entry_price` of the cycle's own order, never the aggregated position size

#### Scenario: Other recovery states
- **WHEN** recovery resolves `entry_order_not_found`, `terminal_without_fill` or `terminal_after_fill`
- **THEN** no `cycle_execution_state` is returned
