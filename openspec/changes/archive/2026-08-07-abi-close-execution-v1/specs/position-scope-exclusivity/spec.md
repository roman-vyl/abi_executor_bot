## MODIFIED Requirements

### Requirement: A scope is released only when its owner's record is durably proven to admit no position
ABI SHALL treat a physical position scope as released by its current owner only when that pair's
correlation record status is `absent`, `terminal_unfilled`, or `terminal_closed` — the statuses under
which no live exchange query is needed to know no exposure exists. Every other status, including but
not limited to `pending_create`, `unknown`, `create_failed`, `applied`, `pending_replace`, and
`pending_cancel`, SHALL keep the scope held by that pair.

#### Scenario: Absent record releases the scope
- **WHEN** a pair's correlation record status becomes `absent`
- **THEN** ABI treats that pair's previously-held scope as released, available for a different pair
  to acquire

#### Scenario: Terminal-without-fill record releases the scope
- **WHEN** a pair's correlation record status becomes `terminal_unfilled`
- **THEN** ABI treats that pair's previously-held scope as released, available for a different pair
  to acquire

#### Scenario: Terminally-closed record releases the scope
- **WHEN** a pair's correlation record status becomes `terminal_closed`
- **THEN** ABI treats that pair's previously-held scope as released, available for a different pair
  to acquire

#### Scenario: An unresolved or live-query-admissible status keeps the scope held
- **WHEN** a pair's correlation record status is `pending_create`, `unknown`, `create_failed`,
  `applied`, `pending_replace`, or `pending_cancel`
- **THEN** ABI continues to treat that pair as the scope's owner, and a different pair's acquisition
  attempt on the same scope fails closed

#### Scenario: A fill does not release the scope
- **WHEN** a pair's correlation record reaches `applied` because a full or partial fill was
  observed
- **THEN** ABI continues to treat that pair as the scope's owner
- **AND** this capability does not itself define any subsequent transition that releases the scope
  after that fill on its own; a durably-closed status reached through a deliberate, verified close is
  what actually releases it, per the scenarios above

### Requirement: Conflicting durable scope ownership fails startup readiness closed, evaluated on final state only
ABI SHALL evaluate scope-ownership conflicts during correlation-store replay only against each
pair's latest (most recently replayed) durable record — never against an intermediate historical
record for a pair that a later record for that same pair has since superseded. If, after every
valid line has been replayed, two different pairs' latest records both claim the same physical
position scope and neither record's status is `absent`, `terminal_unfilled`, or `terminal_closed`,
ABI SHALL fail entry-package readiness rather than silently choosing one as the owner. A scope
legitimately passing between pairs earlier in the log — one pair's record reaching `absent`,
`terminal_unfilled`, or `terminal_closed` before a different pair's later record claims the same
scope — SHALL NOT be treated as a conflict, even if an intermediate line in the log shows both pairs
claiming that scope before the earlier pair's release is replayed. A latest record that is not
durably closed but carries no real exchange binding — an empty `exchange_category`, or a non-empty
category with an empty `exchange_symbol` — SHALL be treated the same way a genuine cross-pair
conflict is: ABI SHALL fail entry-package readiness rather than silently excluding that record from
ownership reconstruction.

#### Scenario: Two simultaneously active owners of one scope block readiness
- **WHEN** correlation-store replay finds two different pairs' latest records both claiming the
  same scope with neither record's status `absent`, `terminal_unfilled`, nor `terminal_closed`
- **THEN** ABI reports entry-package readiness as not ready
- **AND** ABI does not process entry-package execution requests

#### Scenario: Sequential historical reuse of a scope is not a conflict
- **WHEN** correlation-store replay finds pair A's record reaching `absent` or `terminal_unfilled`
  for a scope earlier in the log, followed later by pair B's record claiming the same scope
- **THEN** replay succeeds and ABI treats pair B as the scope's current owner

#### Scenario: An intermediate historical moment is not evaluated as a conflict
- **WHEN** the correlation log contains, in order, pair A claiming a scope, then pair B claiming the
  same scope while pair A's record is not yet durably closed, then a later record for pair A
  reaching `absent` or `terminal_unfilled` for that same scope
- **THEN** replay succeeds, evaluating ownership only from pair A's and pair B's respective latest
  records, and ABI treats pair B as the scope's sole current owner
- **AND** ABI does not fail readiness on account of the earlier, since-superseded moment where both
  pairs' records claimed the scope

#### Scenario: A non-durably-closed record with no real exchange binding blocks readiness
- **WHEN** correlation-store replay finds a pair's latest record whose status is not `absent`,
  `terminal_unfilled`, or `terminal_closed`, and whose `exchange_category` is empty, or whose
  `exchange_category` is `linear` or `spot` but whose `exchange_symbol` is empty
- **THEN** ABI reports entry-package readiness as not ready rather than excluding that record from
  ownership reconstruction

#### Scenario: The same empty-binding shape is valid when durably closed
- **WHEN** correlation-store replay finds a pair's latest record whose status is `absent` or
  `terminal_unfilled` and whose `exchange_category` or `exchange_symbol` is empty
- **THEN** replay succeeds and that record is excluded from ownership reconstruction without failing
  readiness

### Requirement: Scope ownership survives restart and is reconstructed from replay alone
ABI SHALL reconstruct physical position scope ownership entirely from correlation-store replay at
startup, without relying on any in-memory state that could have existed before the restart. Losing
the pre-restart in-memory ownership index SHALL NOT cause ABI to treat a still-owned scope as free.

#### Scenario: A restart does not free a scope still owned by an unresolved or live pair
- **WHEN** ABI restarts and replays a correlation record whose status is none of `absent`,
  `terminal_unfilled`, or `terminal_closed` for a given scope
- **THEN** a different pair's post-restart acquisition attempt on that same scope fails closed,
  identically to how it would have failed before the restart

#### Scenario: A restart does not fabricate ownership for a durably closed pair
- **WHEN** ABI restarts and replays a correlation record whose status is `absent`,
  `terminal_unfilled`, or `terminal_closed` for a given scope, with no other pair holding it
- **THEN** a different pair's post-restart acquisition attempt on that scope succeeds

### Requirement: V1 scope excludes shared same-symbol exposure; post-fill scope release is implemented by close-execution
This capability's documentation SHALL state that it does not implement shared ownership of one
physical scope by multiple trade cycles (deferred to the virtual position ledger tracked as a
separate backlog item). Releasing a scope after it has held a real filled position is no longer
undocumented or deferred: `close-execution` implements it via the `terminal_closed` durably-closed
status this capability now releases a scope for, per the requirement above.

#### Scenario: Shared ownership remains disclosed as deferred; post-fill release is no longer undocumented
- **WHEN** this capability's behavior is documented
- **THEN** the documentation states that multiple trade cycles sharing one physical scope is out of
  scope and tracked separately
- **AND** the documentation does not claim that releasing a scope after a fill is unimplemented or
  left to a future capability
