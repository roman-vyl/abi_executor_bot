## MODIFIED Requirements

### Requirement: The pair is classified before any exchange call
ABI SHALL resolve, in this order and before any exchange call: an unknown pair returns
`unknown_trade_cycle_binding`; a known pair whose record already durably proves no position exists
(the same durable-absence condition `position-scope-exclusivity` treats as releasing that pair's
own active ownership) returns `position_not_open` directly, with no ownership check — such a pair's
scope may already be actively held, in whole or in part, by someone else, so ownership must not be
checked first. Every other pair SHALL have its active ownership of the scope its own record names
independently reconfirmed against the scope's full set of active owners, via
`position-scope-exclusivity`'s existing multi-owner-aware lookup — never inferred from the record's
mere existence, and never from a single-pointer "current owner" answer that cannot represent more
than one active owner. If the requesting pair is not among that scope's active owners, ABI returns
`internal_error`. If the requesting pair is among the scope's active owners but is not its only
active owner, ABI returns `shared_scope_protection_unsupported` — this scope currently has more
than one active owner, and `PUT .../protection`'s single position-level write cannot be attributed
to just one of them. This shared-scope check runs before the live-position check below and before
any exchange call. Only when the requesting pair is confirmed to be the scope's sole active owner
does ABI proceed to the live-position check.

`position-scope-exclusivity`'s own admission requirement continues to admit at most one active
owner per scope through ABI's ordinary write paths — the shared-scope case this requirement
describes is real, tested logic, but is reachable today only via a scope whose active-owner set
was not produced by ABI's own admission path (this capability's own test fixtures use this
technique, the same way `position-scope-exclusivity`'s own replay tests do). It becomes reachable
through genuine traffic only once a later change relaxes that admission requirement.

#### Scenario: Unknown pair fails closed
- **WHEN** no correlation record exists for the requested pair
- **THEN** ABI returns `unknown_trade_cycle_binding`

#### Scenario: Durably absent pair skips the ownership check
- **WHEN** the requested pair's record durably proves no position exists
- **THEN** ABI returns `position_not_open` without checking scope ownership

#### Scenario: Confirmed sole active ownership proceeds
- **WHEN** a non-durably-absent pair is currently the scope's only active owner
- **THEN** ABI proceeds to the live-position check

#### Scenario: An ownership mismatch fails closed
- **WHEN** the scope named by a non-durably-absent pair's record has no active owner matching that
  pair at all
- **THEN** ABI returns `internal_error`

#### Scenario: A shared scope fails closed with a distinct, actionable code before any exchange call
- **WHEN** a non-durably-absent pair is confirmed to be one of a scope's active owners, but that
  scope currently has more than one active owner
- **THEN** ABI returns `shared_scope_protection_unsupported`
- **AND** ABI does not proceed to the live-position check
- **AND** ABI sends no request of any kind to the exchange for this attempt

#### Scenario: Single-owner behavior is unchanged
- **WHEN** a scope has exactly one active owner and it is the requesting pair — the only
  production-reachable state today
- **THEN** ABI's behavior from this point forward (live-position check, already-satisfied
  short-circuit, write, read-back) is identical to its behavior before this capability's ownership
  lookup was changed to a full active-set check
