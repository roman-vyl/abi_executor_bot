## MODIFIED Requirements

### Requirement: A physical position scope is owned by at most one active trade cycle
ABI SHALL allow a physical position scope (`category` + `symbol`, under the configured account and
one-way `positionIdx = 0`) to have multiple active trade cycles only when every active cycle and the
requesting cycle have the same validated entry side. Admission SHALL be decided from the complete
set of other active records for the scope: empty and same-side sets are admissible; any opposite-side
record, missing/invalid side, malformed binding, or contradictory state fails closed. The requesting
pair SHALL be excluded from its own comparison. ABI SHALL NOT apply a temporary single-owner guard,
feature flag, or owner-count fallback.

#### Scenario: Empty scope admits a first owner
- **WHEN** a new cycle applies to a valid scope with no other active record
- **THEN** ABI durably admits it before any exchange write

#### Scenario: Same-side scope admits another owner
- **WHEN** every other active record on the scope has the same side as the requesting cycle
- **THEN** ABI durably admits the requesting cycle and permits its normal entry flow

#### Scenario: Opposite-side scope fails closed
- **WHEN** any other active record on the scope has the opposite side
- **THEN** ABI sends no exchange write for the requesting cycle and returns a safe error
- **AND** existing owners remain unchanged

#### Scenario: Corrupt scope evidence fails closed
- **WHEN** an active record needed for admission has a missing or invalid side or binding, or the
  active set is otherwise contradictory
- **THEN** ABI sends no exchange write and records no successful claim for the requester

#### Scenario: Self-repeat is not classified as a sibling conflict
- **WHEN** an existing pair retries or continues its own lifecycle on a scope that also has same-side
  siblings
- **THEN** ABI excludes that pair's own record from the other-owner classification and permits the
  request according to the remaining set

### Requirement: V1 scope excludes shared same-symbol exposure; post-fill scope release is implemented by close-execution
V1 SHALL support multiple active Runtime-owned trade cycles sharing one physical scope only when they
are all same-side and each cycle's entry, protection, close quantity, close identity, and cleanup are
independently attributable. Opposite-side coexistence, hedge-mode ownership, non-attributable legacy
orders, and partial close remain unsupported and fail closed. Releasing one filled cycle is implemented
by `close-execution` through that cycle's own verified `terminal_closed` transition without releasing
or mutating a remaining sibling.

#### Scenario: Same-side cycles coexist under independent ownership
- **WHEN** two admitted cycles share a scope and side
- **THEN** both remain independently active and all lifecycle writes are scoped to their own identities

#### Scenario: Closing one shared owner preserves the other
- **WHEN** one same-side cycle reaches its verified `terminal_closed` transition
- **THEN** only that cycle is removed from active ownership and every sibling remains active

#### Scenario: Unsupported sharing remains fail closed
- **WHEN** requested coexistence is opposite-side, hedge-mode, non-attributable, or otherwise outside
  the supported geometry
- **THEN** ABI does not admit or mutate the unsupported state
