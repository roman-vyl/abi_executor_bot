## RENAMED Requirements
- FROM: `### Requirement: A physical position scope is owned by at most one active trade cycle`
- TO: `### Requirement: A physical position scope is owned by at most one active side at a time`
- FROM: `### Requirement: This capability introduces no public HTTP contract change`
- TO: `### Requirement: This capability introduces no public HTTP contract change for admission conflicts`
- FROM: `### Requirement: V1 scope excludes shared same-symbol exposure; post-fill scope release is implemented by close-execution`
- TO: `### Requirement: V1 permits same-side shared exposure; opposite-side coexistence remains out of scope`

## MODIFIED Requirements

### Requirement: A physical position scope is owned by at most one active side at a time
ABI SHALL ensure that at any point in time, for a given physical position scope (`category` +
`symbol`, under the single configured account, `positionIdx = 0`), at most one **side**
(`long` or `short`) is active — any number of trade cycle pairs `(strategy_instance_id,
trade_cycle_id)` whose own `desired_entry.side` matches that active side MAY hold the scope
concurrently. Different pairs whose resolved scopes differ SHALL be able to acquire and hold
their own scopes without being serialized against each other by the scope-ownership mechanism
(this does not override any unrelated, pre-existing serialization — such as the correlation
store's own single-writer append ordering — that applies regardless of scope).

#### Scenario: Two different scopes are acquired independently
- **WHEN** pair A applies a desired entry that resolves to scope BTCUSDT and pair B applies a
  desired entry that resolves to scope ETHUSDT, concurrently
- **THEN** both acquisitions succeed
- **AND** neither pair's acquisition is made to wait on the other's by the scope-ownership mechanism

#### Scenario: A same-side pair may join a scope another active pair already holds
- **WHEN** pair A already holds scope BTCUSDT with a status other than `absent`,
  `terminal_unfilled`, or `terminal_closed`, its own `desired_entry.side` is `long`, and pair B
  applies a desired entry whose `side` is also `long` for the same scope
- **THEN** pair B's acquisition succeeds
- **AND** pair A's ownership of the scope is unaffected
- **AND** both pairs are independently active owners of the scope afterward

#### Scenario: An opposite-side pair cannot acquire a scope another active pair already holds
- **WHEN** pair A already holds scope BTCUSDT with a status other than `absent`,
  `terminal_unfilled`, or `terminal_closed`, its own `desired_entry.side` is `long`, and pair B
  applies a desired entry whose `side` is `short` for the same scope
- **THEN** ABI does not send any create, amend, or cancel request to the exchange for pair B's
  request
- **AND** ABI returns a safe error for pair B's request
- **AND** pair A's ownership of the scope is unaffected

#### Scenario: An active record with no usable side blocks a new claim
- **WHEN** a scope already has an active record whose `desired_entry` is `null`, and a pair
  applies a desired entry that resolves to the same scope
- **THEN** ABI does not send any create, amend, or cancel request to the exchange for that
  attempt
- **AND** ABI returns a safe error rather than silently excluding the contradictory record from
  the side check

### Requirement: Scope ownership is derived from existing durable correlation state, not a new store
ABI SHALL derive physical position scope ownership entirely from the existing entry-package
correlation records (`exchange_category`, `exchange_symbol`, `status`, `desired_entry.side`)
already durably persisted by `EntryPackageCorrelationRepository`. ABI SHALL NOT introduce a new
durable store, a new persisted field on the correlation record, or any ownership state that is
not fully reconstructible from the existing correlation log.

#### Scenario: Ownership is computed from existing fields
- **WHEN** ABI needs to determine every pair, if any, currently active on a given scope, and
  which side(s) they hold
- **THEN** ABI answers using only the existing correlation records' stored `exchange_category`,
  `exchange_symbol`, `status`, and `desired_entry.side` fields, with no separate reservation
  record and no new persisted index

### Requirement: Scope acquisition is atomic across concurrently competing trade cycles
When two different pairs concurrently attempt to acquire the same physical position scope for the
first time, ABI SHALL ensure that the side-compatibility decision (join if same side or scope
empty, reject if opposite side) and the durable claim for whichever pair(s) succeed happen with no
window in which two pairs both observe the scope as available for a side it is not.

#### Scenario: Concurrent first-time acquisition of the same scope by same-side pairs both succeed
- **WHEN** pair A and pair B, both without any existing binding and both requesting the same
  side, concurrently apply a desired entry that resolves to the same scope
- **THEN** both durably claim the scope and proceed toward their own exchange create request

#### Scenario: Concurrent first-time acquisition by opposite-side pairs has exactly one winner
- **WHEN** pair A and pair B, both without any existing binding and requesting opposite sides,
  concurrently apply a desired entry that resolves to the same scope
- **THEN** exactly one of them durably claims the scope and proceeds toward an exchange create
  request
- **AND** the other fails closed with no exchange request sent and no durable claim recorded for it

### Requirement: The current owner's repeat commands are always permitted
A pair that already actively holds a physical position scope SHALL be able to continue issuing
repeat, retry, or lifecycle-continuing commands for its own trade cycle without being rejected as
a scope conflict against itself or against any other pair sharing that scope's active side.

#### Scenario: Self-repeat is never treated as a conflict
- **WHEN** a pair that already actively holds a scope issues a repeat or retried command that
  re-enters the scope-acquisition check (e.g. a retried create after a crash, or a same-pair
  re-creation at a new generation during REPLACE)
- **THEN** ABI recognizes the pair as one of the scope's existing active owners and proceeds,
  without returning a scope conflict error

#### Scenario: A pair's own repeat is never compared against a same-side sibling as if it were a conflict
- **WHEN** a pair that already actively holds a scope issues a repeat or retried command, and a
  different, same-side pair is also currently active on that same scope
- **THEN** ABI excludes the requesting pair's own record from the set of other active records
  before evaluating side compatibility
- **AND** the requesting pair's repeat proceeds without a false conflict, regardless of which
  active record any other maintained pointer for the scope currently reflects

### Requirement: A scope acquisition attempt performs no exchange write before its durable claim is committed
ABI SHALL determine and durably commit the outcome of a scope-acquisition attempt — claimed or
rejected — before sending any create, amend, or cancel request to the exchange for that attempt.

#### Scenario: A rejected acquisition never reaches the exchange
- **WHEN** a scope-acquisition attempt is rejected because the scope's active side conflicts with
  the requested side
- **THEN** ABI sends no request of any kind to the exchange for the rejected pair's attempt

#### Scenario: A claimed acquisition's durable record precedes its exchange call
- **WHEN** a scope-acquisition attempt succeeds, whether as the scope's first owner or as an
  additional same-side owner
- **THEN** ABI has already durably persisted the record reflecting that claim before it sends the
  corresponding create request to the exchange

### Requirement: A scope is released only when its owner's record is durably proven to admit no position
ABI SHALL treat a physical position scope as released by one of its active owners only when that
pair's correlation record status is `absent`, `terminal_unfilled`, or `terminal_closed` — the
statuses under which no live exchange query is needed to know no exposure exists. Every other
status, including but not limited to `pending_create`, `unknown`, `create_failed`, `applied`,
`pending_replace`, and `pending_cancel`, SHALL keep that pair as an active owner of the scope. A
scope's active side is cleared only when every one of its active owners has released — while any
other same-side owner remains active, the scope continues to reject opposite-side claims.

#### Scenario: Absent record releases that pair's ownership
- **WHEN** one of a scope's active pairs' correlation record status becomes `absent`
- **THEN** ABI no longer treats that pair as an active owner of the scope
- **AND** any other same-side pair still active on the scope is unaffected

#### Scenario: Terminal-without-fill record releases that pair's ownership
- **WHEN** one of a scope's active pairs' correlation record status becomes `terminal_unfilled`
- **THEN** ABI no longer treats that pair as an active owner of the scope
- **AND** any other same-side pair still active on the scope is unaffected

#### Scenario: Terminally-closed record releases that pair's ownership
- **WHEN** one of a scope's active pairs' correlation record status becomes `terminal_closed`
- **THEN** ABI no longer treats that pair as an active owner of the scope
- **AND** any other same-side pair still active on the scope is unaffected

#### Scenario: An unresolved or live-query-admissible status keeps that pair's ownership held
- **WHEN** a pair's correlation record status is `pending_create`, `unknown`, `create_failed`,
  `applied`, `pending_replace`, or `pending_cancel`
- **THEN** ABI continues to treat that pair as one of the scope's active owners, and an
  opposite-side pair's acquisition attempt on the same scope fails closed while it remains active

#### Scenario: A fill does not release that pair's ownership
- **WHEN** a pair's correlation record reaches `applied` because a full or partial fill was
  observed
- **THEN** ABI continues to treat that pair as an active owner of the scope
- **AND** this capability does not itself define any subsequent transition that releases that
  pair's ownership after that fill on its own; a durably-closed status reached through a
  deliberate, verified close is what actually releases it, per the scenarios above

#### Scenario: A scope's side clears only once every active owner of that side has released
- **WHEN** a scope has two active same-side owners, and one of them durably closes
- **THEN** the closed pair no longer counts as an active owner
- **AND** the remaining pair continues to hold the scope's side, so an opposite-side claim still
  fails closed
- **AND** only once the remaining pair also durably closes does the scope accept a claim for
  either side

### Requirement: Scope ownership survives restart and is reconstructed from replay alone
ABI SHALL reconstruct physical position scope ownership — every active owner and the side they
hold — entirely from correlation-store replay at startup, without relying on any in-memory state
that could have existed before the restart. Losing the pre-restart in-memory ownership index
SHALL NOT cause ABI to treat a still-active side as free.

#### Scenario: A restart does not free a scope's side while any owner of it remains unresolved or live
- **WHEN** ABI restarts and replays a correlation record whose status is none of `absent`,
  `terminal_unfilled`, or `terminal_closed` for a given scope
- **THEN** an opposite-side pair's post-restart acquisition attempt on that same scope fails
  closed, identically to how it would have failed before the restart
- **AND** a same-side pair's post-restart acquisition attempt succeeds

#### Scenario: A restart reconstructs multiple same-side active owners correctly
- **WHEN** ABI restarts and replays a correlation log whose final state has two different pairs'
  latest records both active on the same scope, both with the same `desired_entry.side`
- **THEN** replay succeeds and both pairs are reconstructed as active owners of that scope

#### Scenario: A restart does not fabricate ownership for a durably closed pair
- **WHEN** ABI restarts and replays a correlation record whose status is `absent`,
  `terminal_unfilled`, or `terminal_closed` for a given scope, with no other pair holding it
- **THEN** a different pair's post-restart acquisition attempt on that scope succeeds, for either
  side

### Requirement: Conflicting durable scope ownership fails startup readiness closed, evaluated on final state only
ABI SHALL evaluate scope-ownership conflicts during correlation-store replay only against each
pair's latest (most recently replayed) durable record — never against an intermediate historical
record for a pair that a later record for that same pair has since superseded. If, after every
valid line has been replayed, two different pairs' latest records are both active on the same
physical position scope and their `desired_entry.side` values differ, ABI SHALL fail
entry-package readiness rather than silently choosing one side. Two or more active records on the
same scope that all share the same side is NOT a conflict and SHALL NOT fail readiness. A scope
legitimately passing between pairs earlier in the log — one pair's record reaching `absent`,
`terminal_unfilled`, or `terminal_closed` before a different pair's later record claims the same
scope — SHALL NOT be treated as a conflict, even if an intermediate line in the log shows both
pairs claiming that scope before the earlier pair's release is replayed. A latest record that is
active (not durably closed) but carries no real exchange binding — an empty `exchange_category`,
or a non-empty category with an empty `exchange_symbol` — or no usable `desired_entry.side` SHALL
be treated the same way a genuine cross-pair side conflict is: ABI SHALL fail entry-package
readiness rather than silently excluding that record from ownership reconstruction.

#### Scenario: Mixed-side active owners of one scope block readiness
- **WHEN** correlation-store replay finds two different pairs' latest records both active on the
  same scope with differing `desired_entry.side` values
- **THEN** ABI reports entry-package readiness as not ready
- **AND** ABI does not process entry-package execution requests

#### Scenario: Multiple same-side active owners of one scope do not block readiness
- **WHEN** correlation-store replay finds two or more different pairs' latest records all active
  on the same scope, all sharing the same `desired_entry.side`
- **THEN** ABI reports entry-package readiness as ready
- **AND** all of those pairs are reconstructed as active owners of that scope

#### Scenario: Sequential historical reuse of a scope is not a conflict
- **WHEN** correlation-store replay finds pair A's record reaching `absent`, `terminal_unfilled`, or
  `terminal_closed` for a scope earlier in the log, followed later by pair B's record claiming the
  same scope
- **THEN** replay succeeds and ABI treats pair B as the scope's current active owner, for either side

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

### Requirement: A pair's owned scope is exactly its own stored exchange category and symbol
While a pair actively holds a physical position scope, that scope SHALL be exactly the
`exchange_category` and `exchange_symbol` already stored on that pair's own correlation record —
never a value derived, inferred, or re-resolved from any other source at read time.

#### Scenario: A held pair's own record is authoritative for its scope
- **WHEN** any component needs to know which physical scope a given active pair currently holds
- **THEN** that scope is exactly the pair's own correlation record's `exchange_category` and
  `exchange_symbol`

### Requirement: This capability introduces no public HTTP contract change for admission conflicts
ABI SHALL enforce same-side physical position scope ownership without adding, removing, or
altering any public route, request/response DTO, or public error code across
`abi-entry-package-api`, `abi-open-position-lookup-api`, or `abi-position-management-api` for the
admission (claim) decision specifically. A scope-acquisition conflict — whether because a
different pair already exclusively held it under the prior single-owner model, or because an
opposite side is already active under this capability's current model — SHALL be reported through
the existing `internal_error` response already used for other fail-before-any-exchange-call
outcomes. (A distinct, additive public error code for `PUT .../protection`'s own shared-scope
guard is defined by `protection-execution`/`abi-position-management-api`, not by this
requirement.)

#### Scenario: Scope conflict reuses the existing safe error response
- **WHEN** a scope-acquisition attempt is rejected due to an opposite-side conflict
- **THEN** ABI returns the same `internal_error` response shape already used for other fail-closed
  entry-package outcomes, with no new error code or field

### Requirement: V1 permits same-side shared exposure; opposite-side coexistence remains out of scope
This capability implements shared ownership of one physical scope by any number of trade cycles
that all share the same side. Opposite-side coexistence (a scope simultaneously holding both a
`long` and a `short` active owner, e.g. a hedge-mode-like model) remains explicitly out of scope
and is not implemented by this or any change currently planned. Releasing a scope after it has
held a real filled position continues to be implemented by `close-execution`, as before.

#### Scenario: Same-side sharing is documented as implemented; opposite-side sharing remains disclosed as out of scope
- **WHEN** this capability's behavior is documented
- **THEN** the documentation states that same-side sharing of one physical scope by multiple trade
  cycles is implemented
- **AND** the documentation states that opposite-side coexistence on one scope is not implemented
  and is not currently planned
