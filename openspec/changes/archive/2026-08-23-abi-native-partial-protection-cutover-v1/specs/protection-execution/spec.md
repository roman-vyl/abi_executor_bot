## MODIFIED Requirements

### Requirement: The pair is classified before any exchange call
ABI SHALL resolve, in this order and before any exchange call: an unknown pair returns
`unknown_trade_cycle_binding`; a known pair whose record already durably proves no position exists
returns `position_not_open` directly, without consulting any sibling owner. Every other pair SHALL
have its active membership in the scope named by its own record independently reconfirmed against the
scope's full active-owner set. If the requesting pair is absent from that set, or the set is corrupt
or contradictory, ABI SHALL return `internal_error`. If the pair is present, ABI SHALL proceed for
both a sole-owner and a same-side multi-owner scope; ABI SHALL NOT reject a valid request because a
sibling cycle shares the scope.

#### Scenario: Unknown pair fails closed
- **WHEN** no correlation record exists for the requested pair
- **THEN** ABI returns `unknown_trade_cycle_binding`

#### Scenario: Durably absent pair skips the ownership check
- **WHEN** the requested pair's record durably proves no position exists
- **THEN** ABI returns `position_not_open` without checking scope ownership

#### Scenario: Confirmed active membership proceeds for a sole owner
- **WHEN** a non-durably-absent pair is the scope's only active owner
- **THEN** ABI proceeds to protection reconciliation

#### Scenario: Confirmed active membership proceeds beside same-side siblings
- **WHEN** a non-durably-absent pair is one of multiple same-side active owners of its scope
- **THEN** ABI proceeds to protection reconciliation for that pair
- **AND** sibling ownership alone produces no error

#### Scenario: An ownership mismatch or contradiction fails closed
- **WHEN** the requesting pair is not among the scope's active owners, or active ownership evidence is
  corrupt or contradictory
- **THEN** ABI returns `internal_error` without sending an exchange write

### Requirement: The protection write replaces both legs together
The accepted request SHALL define one complete desired native Partial protection state for the
requested cycle: its stop, take representation, and own currently filled quantity. ABI SHALL
reconcile both attributed legs as one fail-closed operation, even though Bybit child amendments can
be dispatched sequentially. An accepted `take_price` of `null` SHALL be represented by the existing
deterministic dormant surrogate and SHALL NOT cancel either member of the native attached pair.

#### Scenario: A null take_price preserves a complete native pair
- **WHEN** the accepted request's `take_price` is `null`
- **THEN** ABI reconciles the take child to the deterministic dormant surrogate and the stop child to
  the requested stop
- **AND** ABI does not cancel either native child

#### Scenario: Partial leg success is not whole-operation success
- **WHEN** one required child amend succeeds but the complete desired pair is not confirmed afterward
- **THEN** ABI does not acknowledge `protection_applied`

### Requirement: Success requires a verified desired protection state
ABI SHALL return `protection_applied` only after a fresh attribution observation confirms exactly one
active own stop child and exactly one active own take child whose exact-decimal trigger prices and
quantities equal the complete desired state for the requested cycle. A state already matching those
values requires no amend, but still requires the live-execution guard to permit production handling.
An amend acknowledgment alone, aggregate position-level TP/SL fields, or any sibling cycle's children
SHALL NOT prove success.

#### Scenario: An already-satisfied attributable pair requires no amend
- **WHEN** fresh read-back finds exactly one active own stop and one active own take matching the
  desired prices and own filled quantity
- **THEN** ABI sends no amend and returns `protection_applied` with the accepted request values

#### Scenario: Successful amendments require independent read-back
- **WHEN** one or both own children require amendment and Bybit acknowledges every amend
- **THEN** ABI returns success only after a new attribution observation confirms the entire desired
  own pair

#### Scenario: Sibling protection cannot satisfy the request
- **WHEN** a sibling cycle's children match the requested values but the requested cycle's own
  attributable pair does not
- **THEN** ABI does not return `protection_applied`

#### Scenario: A skipped or unconfirmed write fails closed
- **WHEN** the live-execution guard skips a required write, or bounded read-back does not confirm the
  complete desired own pair
- **THEN** ABI returns `internal_error` and does not report `protection_applied`

### Requirement: A native Partial protection reconciliation lifecycle exists, in-place only, and never runs in production
ABI SHALL use the native Partial reconciliation lifecycle as the only production implementation of
`PUT .../protection` for every active requested cycle. It SHALL bring that cycle's attributable
native Partial children into agreement with its desired state only by amending existing children in
place by their own order identities, and SHALL NOT create or cancel an order to reconcile protection.
ABI SHALL NOT route by owner count and SHALL NOT invoke the legacy position-level trading-stop write.

#### Scenario: Production reconciliation only amends existing own children
- **WHEN** a trade cycle's attributable native Partial pair differs from its desired state
- **THEN** ABI amends only the existing attributed stop and/or take child by its own order identity
- **AND** ABI does not create or cancel an order to achieve protection reconciliation

#### Scenario: Single-owner and shared-scope requests use one lifecycle
- **WHEN** `PUT .../protection` is called for either a sole owner or one of multiple same-side owners
- **THEN** both requests use the same native Partial reconciliation lifecycle
- **AND** neither request invokes a position-level trading-stop write
