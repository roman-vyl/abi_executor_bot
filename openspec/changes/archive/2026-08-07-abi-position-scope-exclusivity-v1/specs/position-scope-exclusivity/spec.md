## Purpose

Define the invariant that one physical Bybit position scope — the configured ABI account,
exchange `category`, exchange `symbol`, and one-way `positionIdx = 0` — is owned by at most one
active Runtime-owned trade cycle `(strategy_instance_id, trade_cycle_id)` at a time, how ABI
acquires that ownership atomically before any exchange write, how ownership is derived durably from
existing correlation state, and the currently conservative conditions under which it is released.

## ADDED Requirements

### Requirement: A physical position scope is owned by at most one active trade cycle
ABI SHALL ensure that at any point in time, for a given physical position scope (`category` +
`symbol`, under the single configured account, `positionIdx = 0`), at most one trade cycle pair
`(strategy_instance_id, trade_cycle_id)` holds it. Different pairs whose resolved scopes differ
SHALL be able to acquire and hold their own scopes without being serialized against each other by
the scope-ownership mechanism (this does not override any unrelated, pre-existing serialization —
such as the correlation store's own single-writer append ordering — that applies regardless of
scope).

#### Scenario: Two different scopes are acquired independently
- **WHEN** pair A applies a desired entry that resolves to scope BTCUSDT and pair B applies a
  desired entry that resolves to scope ETHUSDT, concurrently
- **THEN** both acquisitions succeed
- **AND** neither pair's acquisition is made to wait on the other's by the scope-ownership mechanism

#### Scenario: A second pair cannot acquire a scope another active pair already holds
- **WHEN** pair A already holds scope BTCUSDT with a status other than `absent` or
  `terminal_unfilled`, and pair B applies a desired entry that resolves to the same scope
- **THEN** ABI does not send any create, amend, or cancel request to the exchange for pair B's
  request
- **AND** ABI returns a safe error for pair B's request
- **AND** pair A's ownership of the scope is unaffected

### Requirement: Scope ownership is derived from existing durable correlation state, not a new store
ABI SHALL derive physical position scope ownership entirely from the existing entry-package
correlation records (`exchange_category`, `exchange_symbol`, `status`) already durably persisted by
`EntryPackageCorrelationRepository`. ABI SHALL NOT introduce a new durable store, a new persisted
field on the correlation record, or any ownership state that is not fully reconstructible from the
existing correlation log.

#### Scenario: Ownership is computed from existing fields
- **WHEN** ABI needs to determine which pair, if any, currently owns a given scope
- **THEN** ABI answers using only the existing correlation records' stored `exchange_category`,
  `exchange_symbol`, and `status` fields, with no separate reservation record

### Requirement: Scope acquisition is atomic across concurrently competing trade cycles
When two different pairs concurrently attempt to acquire the same physical position scope for the
first time, ABI SHALL ensure that exactly one of them durably claims the scope and the other fails
closed, with no window in which both observe the scope as free.

#### Scenario: Concurrent first-time acquisition of the same scope has exactly one winner
- **WHEN** pair A and pair B, both without any existing binding, concurrently apply a desired entry
  that resolves to the same scope
- **THEN** exactly one of them durably claims the scope and proceeds toward an exchange create
  request
- **AND** the other fails closed with no exchange request sent and no durable claim recorded for it

### Requirement: The current owner's repeat commands are always permitted
A pair that already owns a physical position scope SHALL be able to continue issuing repeat,
retry, or lifecycle-continuing commands for its own trade cycle without being rejected as a scope
conflict against itself.

#### Scenario: Self-repeat is never treated as a conflict
- **WHEN** a pair that already owns a scope issues a repeat or retried command that re-enters the
  scope-acquisition check (e.g. a retried create after a crash, or a same-pair re-creation at a new
  generation during REPLACE)
- **THEN** ABI recognizes the pair as the existing owner and proceeds, without returning a scope
  conflict error

### Requirement: A scope acquisition attempt performs no exchange write before its durable claim is committed
ABI SHALL determine and durably commit the outcome of a scope-acquisition attempt — claimed or
rejected — before sending any create, amend, or cancel request to the exchange for that attempt.

#### Scenario: A rejected acquisition never reaches the exchange
- **WHEN** a scope-acquisition attempt is rejected because another pair already owns the scope
- **THEN** ABI sends no request of any kind to the exchange for the rejected pair's attempt

#### Scenario: A claimed acquisition's durable record precedes its exchange call
- **WHEN** a scope-acquisition attempt succeeds
- **THEN** ABI has already durably persisted the record reflecting that claim before it sends the
  corresponding create request to the exchange

### Requirement: A scope is released only when its owner's record is durably proven to admit no position
ABI SHALL treat a physical position scope as released by its current owner only when that pair's
correlation record status is `absent` or `terminal_unfilled` — the same two statuses under which no
live exchange query is needed to know no exposure exists. Every other status, including but not
limited to `pending_create`, `unknown`, `create_failed`, `applied`, `pending_replace`, and
`pending_cancel`, SHALL keep the scope held by that pair.

#### Scenario: Absent record releases the scope
- **WHEN** a pair's correlation record status becomes `absent`
- **THEN** ABI treats that pair's previously-held scope as released, available for a different pair
  to acquire

#### Scenario: Terminal-without-fill record releases the scope
- **WHEN** a pair's correlation record status becomes `terminal_unfilled`
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
  after that fill; releasing a scope that has held a real position is out of scope for this
  capability and is left to a future position-management capability

### Requirement: Scope ownership survives restart and is reconstructed from replay alone
ABI SHALL reconstruct physical position scope ownership entirely from correlation-store replay at
startup, without relying on any in-memory state that could have existed before the restart. Losing
the pre-restart in-memory ownership index SHALL NOT cause ABI to treat a still-owned scope as free.

#### Scenario: A restart does not free a scope still owned by an unresolved or live pair
- **WHEN** ABI restarts and replays a correlation record whose status is not `absent` or
  `terminal_unfilled` for a given scope
- **THEN** a different pair's post-restart acquisition attempt on that same scope fails closed,
  identically to how it would have failed before the restart

#### Scenario: A restart does not fabricate ownership for a durably closed pair
- **WHEN** ABI restarts and replays a correlation record whose status is `absent` or
  `terminal_unfilled` for a given scope, with no other pair holding it
- **THEN** a different pair's post-restart acquisition attempt on that scope succeeds

### Requirement: Conflicting durable scope ownership fails startup readiness closed, evaluated on final state only
ABI SHALL evaluate scope-ownership conflicts during correlation-store replay only against each
pair's latest (most recently replayed) durable record — never against an intermediate historical
record for a pair that a later record for that same pair has since superseded. If, after every
valid line has been replayed, two different pairs' latest records both claim the same physical
position scope and neither is `absent` nor `terminal_unfilled`, ABI SHALL fail entry-package
readiness rather than silently choosing one as the owner. A scope legitimately passing between
pairs earlier in the log — one pair's record reaching `absent` or `terminal_unfilled` before a
different pair's later record claims the same scope — SHALL NOT be treated as a conflict, even if an
intermediate line in the log shows both pairs claiming that scope before the earlier pair's release
is replayed.

#### Scenario: Two simultaneously active owners of one scope block readiness
- **WHEN** correlation-store replay finds two different pairs' latest records both claiming the
  same scope with neither status `absent` nor `terminal_unfilled`
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

### Requirement: A pair's owned scope is exactly its own stored exchange category and symbol
While a pair holds a physical position scope, that scope SHALL be exactly the `exchange_category`
and `exchange_symbol` already stored on that pair's own correlation record — never a value derived,
inferred, or re-resolved from any other source at read time.

#### Scenario: A held pair's own record is authoritative for its scope
- **WHEN** any component needs to know which physical scope a given non-durably-closed pair
  currently owns
- **THEN** that scope is exactly the pair's own correlation record's `exchange_category` and
  `exchange_symbol`

### Requirement: This capability introduces no public HTTP contract change
ABI SHALL enforce physical position scope exclusivity without adding, removing, or altering any
public route, request/response DTO, or public error code across `abi-entry-package-api`,
`abi-open-position-lookup-api`, or `abi-position-management-api`. A scope-acquisition conflict
SHALL be reported through the existing `internal_error` response already used for other
fail-before-any-exchange-call outcomes.

#### Scenario: Scope conflict reuses the existing safe error response
- **WHEN** a scope-acquisition attempt is rejected due to conflicting ownership
- **THEN** ABI returns the same `internal_error` response shape already used for other fail-closed
  entry-package outcomes, with no new error code or field

### Requirement: V1 scope excludes shared same-symbol exposure and post-fill scope release
This capability's documentation SHALL state that it does not implement shared ownership of one
physical scope by multiple trade cycles (deferred to the virtual position ledger tracked as a
separate backlog item), and does not implement releasing a scope after it has held a real filled
position — that release path is left to a future position-management capability.

#### Scenario: Deferred scope is disclosed, not silently assumed complete
- **WHEN** this capability's behavior is documented
- **THEN** the documentation states that multiple trade cycles sharing one physical scope is
  out of scope and tracked separately
- **AND** the documentation states that releasing a scope after a fill is not yet implemented and is
  left to a future capability
