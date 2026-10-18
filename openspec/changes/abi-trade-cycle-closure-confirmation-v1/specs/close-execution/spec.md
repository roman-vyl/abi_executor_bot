## ADDED Requirements

### Requirement: Close detects a completed cycle before acting on protection or exposure
After the pair's entry order is proven unable to increase the position and its own filled quantity `Q` is resolved, and before ABI cancels any protection leg or dispatches any close order, ABI SHALL evaluate the completion proof of `open-position-resolution`. When completion is proven, ABI SHALL record it durably, SHALL NOT cancel any order or dispatch any close order, and SHALL return `trade_cycle_closed` with that closure.

#### Scenario: Stop filled before Runtime's close
- **WHEN** Runtime requests close for a cycle whose own stop already fully filled
- **THEN** ABI dispatches no close order, records `terminal_closed` with reason `stop_loss`, and returns `trade_cycle_closed`

### Requirement: No close order is dispatched while an own protection leg shows any fill without a full proof
When any own protection leg shows a nonzero executed quantity and completion is not proven, ABI SHALL return `internal_error` and SHALL NOT dispatch a close order. Protection neutralization SHALL NOT count a leg with any fill as clean terminal absence.

#### Scenario: Same-side sibling in the scope
- **WHEN** this cycle's own stop shows a fill, completion is not proven, and a same-side sibling holds a position in the scope
- **THEN** ABI dispatches no close order and returns `internal_error`
