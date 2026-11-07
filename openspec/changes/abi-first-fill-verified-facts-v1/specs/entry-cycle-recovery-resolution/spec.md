## ADDED Requirements

### Requirement: Missing recovery first-fill uses the shared verified execution proof after unsuccessful REST
After existing recovery truth resolution, ABI SHALL reuse a captured first_fill unchanged or perform the existing REST capture first, using verified-first-fill-evidence only if REST cannot establish a timestamp. Both position_open capture and terminal_after_fill best-effort capture SHALL use identical proof rules. This SHALL NOT change recovery outcome classification, convergence, public responses or write-failure semantics.

#### Scenario: Open recovery has complete local executions while REST history is delayed
- **WHEN** recovery proves position_open, no first_fill is saved and matching complete executions are locally available
- **THEN** ABI obtains the true earliest time from that proof and follows existing capture/convergence, after the unsuccessful REST capture, without waiting for future REST history propagation

#### Scenario: Terminal recovery retains best-effort timestamp capture
- **WHEN** terminal_after_fill is independently proven but neither local nor REST capture provides a timestamp
- **THEN** the terminal outcome SHALL NOT be blocked solely by missing first_fill; existing convergence persistence requirements remain enforced

#### Scenario: Local facts do not decide recovery truth
- **WHEN** local executions exist but existing recovery resolution cannot establish a non-contradictory outcome
- **THEN** the verifier SHALL NOT convert the unresolved outcome into position_open or terminal_after_fill


### Requirement: Local first-fill fallback never uses a live entry cumulative snapshot
Any SQLite timestamp fallback in this capability SHALL require terminal-entry eligibility under verified-first-fill-evidence before reading local facts or links. It SHALL NOT change existing REST capture for live partial fills or existing branch-specific failure/best-effort semantics.

#### Scenario: REST capture is empty while the entry remains live
- **WHEN** no timestamp is saved, REST capture cannot establish one and the entry is PartiallyFilled or otherwise not proven terminal
- **THEN** ABI SHALL NOT read SQLite to capture first_fill and SHALL retain the existing outcome of that branch
