## ADDED Requirements

### Requirement: Missing recovery first-fill uses the shared verified execution proof before REST
After existing recovery truth resolution, ABI SHALL reuse a captured first_fill unchanged or use verified-first-fill-evidence before the existing REST capture. Both position_open capture and terminal_after_fill best-effort capture SHALL use identical proof rules. This SHALL NOT change recovery outcome classification, convergence, public responses or write-failure semantics.

#### Scenario: Open recovery has complete local executions while REST history is delayed
- **WHEN** recovery proves position_open, no first_fill is saved and matching complete executions are locally available
- **THEN** ABI obtains the true earliest time from that proof and follows existing capture/convergence, without waiting for REST execution history

#### Scenario: Terminal recovery retains best-effort timestamp capture
- **WHEN** terminal_after_fill is independently proven but neither local nor REST capture provides a timestamp
- **THEN** the terminal outcome SHALL NOT be blocked solely by missing first_fill; existing convergence persistence requirements remain enforced

#### Scenario: Local facts do not decide recovery truth
- **WHEN** local executions exist but existing recovery resolution cannot establish a non-contradictory outcome
- **THEN** the verifier SHALL NOT convert the unresolved outcome into position_open or terminal_after_fill
