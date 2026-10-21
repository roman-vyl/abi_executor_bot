## Purpose

Define the invariant that one physical Bybit position scope — the configured ABI account,
exchange `category`, exchange `symbol`, and one-way `positionIdx = 0` — is owned by at most one
active Runtime-owned trade cycle `(strategy_instance_id, trade_cycle_id)` at a time, how ABI
acquires that ownership atomically before any exchange write, how ownership is derived durably from
existing correlation state, and the currently conservative conditions under which it is released.
## Requirements
### Requirement: A physical position scope is owned by at most one active trade cycle
ABI SHALL distinguish an instrument scope from its long and short directional physical slots. The
correlation repository SHALL be capable of reconstructing multiple active owners within one
directional slot and distinct long and short slots under one instrument. During this foundation
phase, production admission SHALL retain the existing conservative instrument-level policy:
multiple same-side pairs are admissible, while any opposite-side or corrupt active owner on the
same instrument causes the requester to fail closed before a durable claim or exchange write.

#### Scenario: Two different scopes are acquired independently
- **WHEN** pair A applies a desired entry that resolves to scope BTCUSDT and pair B applies a
  desired entry that resolves to scope ETHUSDT, concurrently
- **THEN** both acquisitions succeed
- **AND** neither pair's acquisition is made to wait on the other's by the scope-ownership mechanism

#### Scenario: A second pair cannot acquire a scope another active pair already holds
- **WHEN** pair A already holds scope BTCUSDT with a status other than `absent`,
  `terminal_unfilled`, or `terminal_closed`, and pair B applies a desired entry that resolves to the
  same scope
- **THEN** ABI does not send any create, amend, or cancel request to the exchange for pair B's
  request
- **AND** ABI returns a safe error for pair B's request
- **AND** pair A's ownership of the scope is unaffected

#### Scenario: Same-side pair joins the existing directional ownership set
- **WHEN** pair A is an active long owner and pair B requests a long entry for the same instrument
- **THEN** pair B remains admissible under the existing same-side multi-owner policy
- **AND** both virtual owners resolve to the same directional slot when their binding geometry is
  hedge

#### Scenario: Opposite directional slots remain production-gated
- **WHEN** pair A is an active long owner and pair B requests a short entry for the same instrument
- **THEN** pair B is rejected before its durable claim or any exchange write
- **AND** the internal ability to distinguish the two slots does not relax production admission

#### Scenario: Different instruments remain independent
- **WHEN** two pairs concurrently request entries whose category or symbol differs
- **THEN** neither request is rejected as an ownership conflict caused by the other instrument

### Requirement: Scope ownership is derived from existing durable correlation state, not a new store
ABI SHALL derive instrument and physical-slot ownership from the existing entry-package correlation
log. A minimal durable binding-geometry discriminator SHALL distinguish actual one-way bindings from
hedge bindings across restart and cutover; directional long/short slot identity SHALL be derived
from the existing stored desired-entry side and SHALL NOT be persisted as a second truth. ABI SHALL
NOT introduce a separate ownership store or reservation log.

#### Scenario: Ownership is computed from existing fields
- **WHEN** ABI needs to determine which pair, if any, currently owns a given scope
- **THEN** ABI answers using only correlation records' durable exchange identity, status, binding
  geometry, and desired-entry side, with no separate reservation record

#### Scenario: Hedge ownership is reconstructed without duplicate slot truth
- **WHEN** replay encounters a hedge binding with a valid stored desired-entry side
- **THEN** ABI reconstructs its instrument scope from stored exchange category and symbol
- **AND** derives its directional slot from that side

#### Scenario: Binding geometry justifies the only durable schema addition
- **WHEN** replay must distinguish an actual historical one-way binding from a future hedge binding
  having the same category, symbol, and side
- **THEN** it uses the durable binding-geometry discriminator
- **AND** no duplicated position side or numeric exchange slot is stored

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

### Requirement: Conflicting durable scope ownership fails startup readiness closed, evaluated on final state only
ABI SHALL reconstruct ownership only from each pair's latest durable record. It SHALL build
instrument-scope and directional-slot views without conflating long and short hedge slots. During
this foundation phase, an active mixed-side final state on one instrument SHALL still prevent
startup readiness as an unsupported production policy state, even though it is structurally
representable as two distinct slots. Multiple active final records on the same side SHALL remain
valid. Missing or invalid binding geometry, exchange identity, or required desired-entry side SHALL
fail closed. Durably closed records SHALL not participate in current ownership conflicts.

#### Scenario: Mixed-side active owners of one scope block readiness
- **WHEN** correlation-store replay finds active long and short owners of one instrument during this
  foundation phase
- **THEN** ABI reports entry-package readiness as not ready
- **AND** ABI does not process entry-package execution requests

#### Scenario: Multiple same-side active owners of one scope do not block readiness
- **WHEN** correlation-store replay finds multiple active records on one instrument whose stored
  desired-entry sides are identical and whose bindings are structurally valid
- **THEN** readiness is not blocked merely by their shared side or directional slot
- **AND** all owners are reconstructed

#### Scenario: Sequential historical reuse of a scope is not a conflict
- **WHEN** pair A reaches a durably closed status before pair B later claims the same scope
- **THEN** replay succeeds and treats pair B as the current owner

#### Scenario: An intermediate historical moment is not evaluated as a conflict
- **WHEN** intermediate log lines show both pairs claiming a scope but their latest records leave
  only one active owner
- **THEN** replay evaluates the latest records and does not fail on the superseded intermediate state

#### Scenario: A non-durably-closed record with no real exchange binding blocks readiness
- **WHEN** a latest active record has an empty exchange category or exchange symbol
- **THEN** ABI reports entry-package readiness as not ready rather than excluding that record

#### Scenario: A non-durably-closed record with no usable side blocks readiness
- **WHEN** a latest active record has no usable stored desired-entry side
- **THEN** ABI reports entry-package readiness as not ready rather than guessing a slot

#### Scenario: The same empty-binding shape is valid when durably closed
- **WHEN** a latest durably closed record has an empty exchange binding
- **THEN** replay succeeds and excludes that record from current ownership

#### Scenario: Mixed-side hedge records are distinguished but remain unsupported
- **WHEN** replay finds an active long hedge record and active short hedge record for the same
  instrument
- **THEN** replay identifies two distinct directional slots rather than a key collision
- **AND** startup readiness remains false because mixed-side production lifecycle support has not
  yet been activated

#### Scenario: Multiple same-side records remain ready
- **WHEN** replay finds multiple active records on the same side with valid binding geometry and
  exchange identity
- **THEN** startup readiness is not blocked merely by their shared directional slot
- **AND** all owners are reconstructed

#### Scenario: Historical mixed ownership does not affect latest-state readiness
- **WHEN** intermediate log lines show conflicting ownership but each pair's latest records no
  longer form an active mixed-side set
- **THEN** replay evaluates only the latest records and does not fail on the superseded history

### Requirement: A pair's owned scope is exactly its own stored exchange category and symbol
While a pair holds ownership, its instrument scope SHALL be exactly its own stored exchange
category and symbol. Its binding geometry SHALL come from its own durable discriminator. For a
hedge binding only, its directional slot SHALL be derived from its own stored desired-entry side.
ABI SHALL NOT re-resolve these facts from another owner's record or from aggregate position state.

#### Scenario: A held pair's own record is authoritative for its scope
- **WHEN** any component reconstructs the physical binding of an active pair
- **THEN** exchange category, symbol, binding geometry, and desired-entry side come from that pair's
  own latest correlation record

#### Scenario: Pair-local facts reconstruct ownership
- **WHEN** ABI reconstructs an active hedge pair's ownership
- **THEN** category, symbol, binding geometry, and desired-entry side all come from that pair's own
  latest correlation record
- **AND** no sibling record or aggregate position supplies its slot

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

### Requirement: V1 scope excludes shared same-symbol exposure; post-fill scope release is implemented by close-execution
This foundation SHALL preserve current production support for independently attributable same-side
owners and verified per-pair release through `terminal_closed`. Opposite-side coexistence and Hedge
Mode execution SHALL remain unsupported until separate entry, open-position, protection, close, and
recovery cutovers are complete and a final admission change removes the instrument-level gate.

#### Scenario: Shared ownership remains disclosed as deferred; post-fill release is no longer undocumented
- **WHEN** this foundation capability's behavior is documented
- **THEN** simultaneous opposite-side production ownership remains deferred to later lifecycle
  cutovers
- **AND** verified `terminal_closed` convergence remains the implemented post-fill release path

#### Scenario: Foundation preserves supported same-side lifecycle
- **WHEN** multiple same-side owners share an instrument during the foundation phase
- **THEN** their existing pair-scoped entry, protection, close, and release behavior remains
  supported

#### Scenario: Directional representation does not promise lifecycle support
- **WHEN** ABI can construct distinct long and short physical-slot identities
- **THEN** documentation and behavior still reject simultaneous opposite-side production ownership
  until the later cutovers are complete

### Requirement: Structural ownership validity is distinct from activation policy
ABI SHALL reconstruct explicit hedge-long and hedge-short owners into separate directional slots
without treating their coexistence as a structural collision. A separate production activation
policy SHALL continue to reject mixed-side active state at admission and readiness throughout this
change.

#### Scenario: Structurally valid but policy-blocked mixed hedge state
- **WHEN** replay finds valid explicit hedge owners in both directional slots of one instrument
- **THEN** both slot memberships are reconstructed
- **AND** production readiness remains false with the retained unsupported-mixed-side policy reason

#### Scenario: Ordinary mixed-side admission remains blocked
- **WHEN** a production entry request asks for the opposite side of an active owner after this
  readiness change
- **THEN** ABI rejects it before a provisional durable write and before exchange I/O

### Requirement: Instrument admission serialization remains the correctness boundary
Admission SHALL continue to serialize on the parent instrument scope, not only the requested
directional slot. The serialized decision SHALL be able to inspect one-way owners and both hedge
slots before committing a claim. Pair serialization SHALL remain the outer lock and instrument
serialization the inner lock.

#### Scenario: Same-instrument opposite requests race during readiness phase
- **WHEN** two production pairs concurrently request opposite sides of one instrument
- **THEN** the instrument-level admission boundary prevents both from committing mixed-side claims

#### Scenario: Different instruments remain independent
- **WHEN** requests target different instrument scopes
- **THEN** the admission mutex does not serialize one instrument behind the other

### Requirement: Active binding geometries never alias or mix
An active one-way binding SHALL remain instrument-scoped and SHALL never alias a directional slot.
An active discriminator-less legacy binding SHALL continue to require drain. Active one-way and
active hedge bindings for the same instrument SHALL be treated as an incompatible geometry state,
not as same-side co-ownership. Binding mode SHALL remain immutable within a generation.

#### Scenario: One-way and hedge owners share a side
- **WHEN** active one-way and hedge records for the same instrument both carry desired side `long`
- **THEN** ABI rejects the geometry mixture despite their matching virtual side

#### Scenario: Inactive historical geometries coexist
- **WHEN** inactive legacy or explicit one-way history precedes a later synthetic hedge binding
- **THEN** replay preserves each record's historical provenance
- **AND** inactive history does not claim a current directional slot

### Requirement: Same-side multi-owner behavior is preserved per physical binding
Multiple active owners of the same one-way scope under current production behavior, and multiple
controlled explicit hedge owners of the same directional slot, SHALL retain independent pair
identity and lifecycle attribution. Releasing one owner SHALL not release or overwrite its siblings.

#### Scenario: Two synthetic owners share one hedge slot
- **WHEN** controlled internal state contains two active records bound to the same directional slot
- **THEN** both are reconstructed as owners of that slot
- **AND** closing one pair does not remove the other's ownership

### Requirement: Production admission is binding-aware under hedge policy
ABI SHALL classify all active owners of an instrument by binding geometry and directional slot before admitting a new owner. Under hedge policy, explicit hedge-long and hedge-short owners MAY coexist, including multiple independent owners in either same directional slot. ABI SHALL reject active legacy state, one-way/hedge mixtures, corrupt bindings, and any binding incompatible with deployment policy.

#### Scenario: Opposite hedge slot is admitted
- **WHEN** one explicit hedge-long owner is active and an independent strategy instance requests a hedge-short binding for the same instrument
- **THEN** ABI admits the short owner into the distinct directional slot after all other gates succeed

#### Scenario: Same-slot multi-owner is preserved
- **WHEN** multiple independent pairs request the same directional hedge slot
- **THEN** each pair retains independent ownership and lifecycle attribution

#### Scenario: Geometry mixture is rejected
- **WHEN** active state contains one-way, legacy, or incompatible binding geometry under hedge policy
- **THEN** ABI rejects the new claim before durable write and exchange I/O

#### Scenario: One-way policy retains same-side restriction
- **WHEN** one-way policy is active and an opposite-side owner already exists for an instrument
- **THEN** ABI rejects mixed-side admission as before

### Requirement: Instrument serialization covers assurance classification and claim
Pair serialization SHALL remain the outer boundary and instrument serialization the inner boundary. For an admission that can create a new physical owner, the instrument boundary SHALL cover active-owner lookup, geometry classification, any required fresh mode assurance, and the durable provisional claim; exchange create SHALL occur only after the instrument boundary releases.

#### Scenario: Concurrent opposite first owners
- **WHEN** long and short requests concurrently seek the first hedge claims on one inactive instrument
- **THEN** one instrument-serialized decision durably claims before the other reclassifies the updated owners
- **AND** both may ultimately occupy separate slots only through individually valid decisions

#### Scenario: Different instruments do not block each other
- **WHEN** admissions target different instrument scopes
- **THEN** their instrument admission decisions can proceed independently

