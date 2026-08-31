## MODIFIED Requirements

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
