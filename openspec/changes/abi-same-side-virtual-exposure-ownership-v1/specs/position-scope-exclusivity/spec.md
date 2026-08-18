## MODIFIED Requirements

### Requirement: Conflicting durable scope ownership fails startup readiness closed, evaluated on final state only
ABI SHALL evaluate scope-ownership conflicts during correlation-store replay only against each
pair's latest (most recently replayed) durable record — never against an intermediate historical
record for a pair that a later record for that same pair has since superseded. If, after every
valid line has been replayed, two or more different pairs' latest records are all active on the
same physical position scope and their `desired_entry.side` values are not all identical, ABI
SHALL fail entry-package readiness rather than silently choosing a side. Two or more active
records on the same scope whose `desired_entry.side` values are all identical is NOT, by itself, a
readiness conflict. A scope legitimately passing between pairs earlier in the log — one pair's
record reaching `absent`, `terminal_unfilled`, or `terminal_closed` before a different pair's later
record claims the same scope — SHALL NOT be treated as a conflict, even if an intermediate line in
the log shows both pairs claiming that scope before the earlier pair's release is replayed. A
latest record that is active (not durably closed) but carries no real exchange binding — an empty
`exchange_category`, or a non-empty category with an empty `exchange_symbol` — or no usable
`desired_entry.side` SHALL be treated the same way a genuine cross-pair side conflict is: ABI SHALL
fail entry-package readiness rather than silently excluding that record from ownership
reconstruction.

This same-side relaxation describes replay reconstruction only. It does not, by itself, change
when a scope can come to hold more than one active record in the first place: the separate
admission requirement above (`A physical position scope is owned by at most one active trade
cycle`) is unchanged by this relaxation and continues to prevent every ordinary write path from
ever producing more than one active record for one scope. In ABI's current implementation, a
correlation log containing two or more same-side active records for one scope can therefore only
arise from a source outside ABI's own admission path (e.g. a directly constructed or edited
correlation file, as used by this capability's own test fixtures) — never from a sequence of
`PUT .../entry-package` requests ABI itself processed. Replay reconstructing such a log without
failing readiness is deliberately prepared, forward-looking behavior for a future change that may
relax the admission requirement itself; it is not, on its own, evidence that same-side sharing is
currently reachable through normal operation.

#### Scenario: Mixed-side active owners of one scope block readiness
- **WHEN** correlation-store replay finds two or more different pairs' latest records all active
  on the same scope, and their `desired_entry.side` values are not all identical
- **THEN** ABI reports entry-package readiness as not ready
- **AND** ABI does not process entry-package execution requests

#### Scenario: Multiple same-side active owners of one scope do not block readiness
- **WHEN** correlation-store replay finds two or more different pairs' latest records all active
  on the same scope, all sharing the same `desired_entry.side`
- **THEN** ABI reports entry-package readiness as ready
- **AND** all of those pairs are reconstructed as active owners of that scope
- **AND** this scenario is exercised only against a correlation log not itself produced by ABI's
  own admission path, since that path continues to admit at most one active record per scope

#### Scenario: Sequential historical reuse of a scope is not a conflict
- **WHEN** correlation-store replay finds pair A's record reaching `absent`, `terminal_unfilled`, or
  `terminal_closed` for a scope earlier in the log, followed later by pair B's record claiming the
  same scope
- **THEN** replay succeeds and ABI treats pair B as the scope's current active owner

#### Scenario: An intermediate historical moment is not evaluated as a conflict
- **WHEN** the correlation log contains, in order, pair A claiming a scope, then pair B claiming the
  same scope while pair A's record is not yet durably closed, then a later record for pair A
  reaching `absent`, `terminal_unfilled`, or `terminal_closed` for that same scope
- **THEN** replay succeeds, evaluating ownership only from pair A's and pair B's respective latest
  records, and ABI treats pair B as the scope's sole current active owner
- **AND** ABI does not fail readiness on account of the earlier, since-superseded moment where both
  pairs' records claimed the scope

#### Scenario: A non-durably-closed record with no real exchange binding blocks readiness
- **WHEN** correlation-store replay finds a pair's latest record whose status is not `absent`,
  `terminal_unfilled`, or `terminal_closed`, and whose `exchange_category` is empty, or whose
  `exchange_category` is `linear` or `spot` but whose `exchange_symbol` is empty
- **THEN** ABI reports entry-package readiness as not ready rather than excluding that record from
  ownership reconstruction

#### Scenario: A non-durably-closed record with no usable side blocks readiness
- **WHEN** correlation-store replay finds a pair's latest record that is active (not durably
  closed) but whose `desired_entry` is `null`
- **THEN** ABI reports entry-package readiness as not ready rather than excluding that record from
  ownership reconstruction

#### Scenario: The same empty-binding shape is valid when durably closed
- **WHEN** correlation-store replay finds a pair's latest record whose status is `absent`,
  `terminal_unfilled`, or `terminal_closed`, and whose `exchange_category` or `exchange_symbol` is
  empty
- **THEN** replay succeeds and that record is excluded from ownership reconstruction without failing
  readiness
