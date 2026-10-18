## MODIFIED Requirements

### Requirement: Close success means both postconditions are verified under complete pair correlation
A successful response SHALL be HTTP `200` with a closed JSON object containing exactly
`strategy_instance_id`, `trade_cycle_id`, `status: "trade_cycle_closed"`, and `closure`.
`trade_cycle_closed` SHALL be returned only once ABI has verified both: the requested cycle's own
resolved exposure has actually been closed, and no order ABI attributes to the pair remains active — and only when the
pair's stored correlation is complete and non-contradictory. ABI's proof that the requested cycle's
own exposure was closed SHALL be attributable to that cycle's own close activity or its own native
protection's full execution specifically, not inferred solely from a before/after change in the scope's
aggregate live position size, since that aggregate can also move because of a sibling trade cycle
sharing the same physical scope. Incomplete or contradictory correlation, or accepting the close
request alone, SHALL NOT produce this status or any other `2xx`. `closure` SHALL have the shape of the
open-position `closure` object: the proven reason and identifiers when the cycle's own entry had a
fill, and `null` when it had none.

#### Scenario: Verified full close is acknowledged
- **WHEN** ABI has verified, attributably to the requested cycle's own close activity, that its
  resolved exposure is closed, and no attributable active order remains, under complete pair
  correlation
- **THEN** ABI returns HTTP `200` with `status: "trade_cycle_closed"` and a `runtime_signal` closure

#### Scenario: Close after a protection exit is acknowledged with that reason
- **WHEN** the cycle's own stop or take-profit already fully closed it
- **THEN** ABI returns HTTP `200` with `status: "trade_cycle_closed"` and a `stop_loss` or `take_profit` closure

#### Scenario: Close of a never-filled cycle
- **WHEN** the cycle's own entry never filled and cleanup is verified
- **THEN** ABI returns HTTP `200` with `status: "trade_cycle_closed"` and `closure: null`

#### Scenario: Incomplete or contradictory correlation blocks success
- **WHEN** the pair's stored correlation data is incomplete or internally contradictory
- **THEN** ABI does not return `trade_cycle_closed` or any other `2xx`
