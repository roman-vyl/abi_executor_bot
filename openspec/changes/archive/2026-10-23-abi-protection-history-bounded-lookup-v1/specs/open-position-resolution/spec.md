## MODIFIED Requirements

### Requirement: Own protection is classified into exactly one state class
For a cycle whose own entry is terminal with cumulative filled quantity `Q`, ABI SHALL classify the result of resolving own attached protection (attribution by `parentOrderLinkId` equal to the entry `orderLinkId`, role by `stopOrderType`) into exactly one class:

- active: an attributed pair, both legs with zero executed quantity, at least one leg live;
- neutralized: an attributed pair, both legs with zero executed quantity and terminal without fill; or no candidates when `Q` is zero;
- completed: an attributed pair where one leg is `Filled` with `leavesQty` zero and `cumExecQty` equal to `Q`, the other leg is terminal without fill with zero executed quantity, and the filled leg's `Trade` executions sum to exactly `Q`; or exactly one own leg found, `Filled` with `leavesQty` zero and `cumExecQty` equal to `Q`, whose `Trade` executions sum to exactly `Q`, when the history read covered the whole cycle lifetime from its start to now without a cap or failed page and the other leg is not live (not among the active orders read in the same resolution);
- partial or contradictory: an attributed pair with any other executed quantity on either leg;
- unknown: no candidates while `Q` is positive, or any other ambiguous result (`partial_pair` not meeting the completed rule above, `query_failed`, `inconsistent_duplicate`, `duplicate_role`, `extra_candidates`, `unclassified_role`).

No candidates and `partial_pair` SHALL NOT be treated as proof that protection did not execute, except for the single filled leg that meets every condition of the completed class. The aggregate position SHALL NOT be a condition of the completed class.

#### Scenario: Demo stop exit
- **WHEN** the stop child is `Filled` with `cumExecQty` equal to `Q` and `leavesQty` zero, the take child is `Deactivated`, and the stop's `Trade` executions sum to `Q`
- **THEN** the class is completed with role stop

#### Scenario: Stop found after the take-profit left the history
- **WHEN** the own stop is `Filled` for `Q` with executions summing to `Q`, the take-profit is not returned, the history read covered the whole cycle lifetime, and no own order is live
- **THEN** the class is completed with role stop
- **AND** the cycle is recorded `terminal_closed` with reason `stop_loss`

#### Scenario: Single filled leg while a sibling holds a position in the scope
- **WHEN** the same single filled leg is found and a same-side sibling keeps a position in the scope
- **THEN** the class is still completed

#### Scenario: Filled leg with a live sibling leg
- **WHEN** one own leg is `Filled` and the other own leg is still live
- **THEN** the class is not completed (partial or contradictory, or unknown as today)

#### Scenario: Incomplete history read
- **WHEN** the same single filled leg is found but the history read did not cover the whole cycle lifetime
- **THEN** the class is unknown and nothing is written

#### Scenario: Partially executed leg
- **WHEN** a leg is `PartiallyFilled`, or filled for a quantity other than `Q`
- **THEN** the class is partial or contradictory

#### Scenario: Children not visible
- **WHEN** `Q` is positive and no own child is found
- **THEN** the class is unknown
