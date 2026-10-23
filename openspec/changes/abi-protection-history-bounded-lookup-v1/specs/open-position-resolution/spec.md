## ADDED Requirements

### Requirement: One filled own leg proves completion when the other leg left the history window
ABI SHALL classify own protection as completed when exactly one own leg is found, that leg is `Filled` with `leavesQty` zero and `cumExecQty` equal to `Q`, its `Trade` executions sum to exactly `Q`, the history read covered the whole cycle lifetime without a cap or failed page, and the aggregate position query for the cycle's physical binding reports no position. Any other single-leg shape SHALL remain unknown. The absence of the opposite leg SHALL NOT by itself block completion, because Bybit keeps cancelled legs without a fill for only 24 hours.

#### Scenario: Stop filled days ago, take-profit no longer in history
- **WHEN** the own stop is `Filled` for `Q` with matching executions, the take-profit is not returned, the history read was complete and the scope has no position
- **THEN** the class is completed with role stop
- **AND** the cycle is recorded `terminal_closed` with reason `stop_loss`

#### Scenario: Incomplete read
- **WHEN** the same single filled leg is found but the history read did not cover the whole cycle lifetime
- **THEN** the class is unknown and nothing is written

#### Scenario: Position still present
- **WHEN** the same single filled leg is found but the aggregate query reports a position for the binding
- **THEN** the class is unknown
