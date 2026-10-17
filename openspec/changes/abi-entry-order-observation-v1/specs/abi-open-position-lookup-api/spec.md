## ADDED Requirements

### Requirement: Open-position response reports the cycle's own executed quantity

When `position_open` is `true`, the open-position response MUST include
`executed_quantity` equal to the cumulative filled quantity of the requested cycle's own
entry order, next to the existing `average_entry_price`, and MUST NOT derive it from
Bybit's aggregated position.

#### Scenario: Own executed quantity differs from the aggregate
- **WHEN** the cycle's own entry order executed 0.01 and Bybit's aggregated position is 0.10
- **THEN** `executed_quantity` is `0.01`

#### Scenario: Position not open
- **WHEN** `position_open` is `false`
- **THEN** `executed_quantity` is `null` and no Bybit request is added
