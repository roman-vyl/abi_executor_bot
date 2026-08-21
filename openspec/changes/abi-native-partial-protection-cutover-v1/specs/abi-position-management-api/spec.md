## MODIFIED Requirements

### Requirement: Protection success is a closed object, confirmed by exact numeric equality
A successful protection response SHALL remain HTTP `200` with exactly
`strategy_instance_id`, `trade_cycle_id`, `status: "protection_applied"`, `stop_price`, and
nullable `take_price`. ABI SHALL return it only after fresh read-back confirms the requested cycle's
exactly attributed active native Partial stop/take pair has the desired exact-decimal trigger prices
and own filled quantity. For `take_price: null`, the exchange take child SHALL equal the deterministic
dormant surrogate while the public response preserves `null`. Aggregate position TP/SL fields and
sibling children SHALL NOT prove success.

#### Scenario: Explicit take succeeds only on exact own-pair equality
- **WHEN** fresh attribution confirms exactly one active own stop and take with requested trigger
  prices and own quantity
- **THEN** ABI returns the closed `protection_applied` response with the request's exact strings

#### Scenario: Disabled take preserves public null after surrogate confirmation
- **WHEN** the requested stop and computed dormant own take child are freshly confirmed
- **THEN** ABI returns `take_price: null`, not the surrogate exchange price

#### Scenario: Unconfirmed or sibling-only equality is not success
- **WHEN** only aggregate fields or a sibling's children match, or own pair read-back is ambiguous
- **THEN** ABI returns no successful protection response

### Requirement: Close means the requested cycle's full resolved exposure, determined by ABI
The only accepted V1 fraction remains canonical exact-decimal `"1"`. ABI SHALL derive the requested
cycle's full exposure solely from its exact own entry fill evidence for both sole-owner and shared
scopes, and SHALL never substitute the aggregate position size. Runtime SHALL NOT supply a quantity.

#### Scenario: ABI determines the own size to close
- **WHEN** ABI processes a close for a cycle with positive own filled exposure
- **THEN** ABI closes all of that exact exposure under the cycle's own stable close identity
- **AND** no partial-close outcome is possible

#### Scenario: Sole-owner close does not use a legacy aggregate-size path
- **WHEN** the requested cycle is the scope's only active owner
- **THEN** its close quantity and proof use the same own-evidence path as a shared-scope owner

#### Scenario: A sibling cycle's exposure is never included
- **WHEN** the requested pair's scope has multiple same-side cycles
- **THEN** the close excludes every sibling's share

### Requirement: Close cancels only orders it attributes to the pair
ABI SHALL neutralize the requested cycle's exact residual entry order and exact native Partial
children attributed through that entry's parent linkage, and SHALL NOT cancel any order it cannot
attribute to that pair. ABI SHALL NOT use account-wide or symbol-wide cancellation.

#### Scenario: Only exact pair-owned orders are cancelled
- **WHEN** ABI closes a cycle
- **THEN** it cancels only the cycle's exact residual entry and exact attributed active Partial children
- **AND** no sibling, manual, or otherwise non-attributable order is cancelled

#### Scenario: Ambiguous attribution blocks cleanup success
- **WHEN** ABI cannot cleanly identify the requested cycle's own native children
- **THEN** ABI does not guess, cancel candidates heuristically, or return `trade_cycle_closed`

### Requirement: Close success means both postconditions are verified under complete pair correlation
A successful close response SHALL remain HTTP `200` with exactly `strategy_instance_id`,
`trade_cycle_id`, and `status: "trade_cycle_closed"`. It SHALL require fresh confirmation that the
requested cycle's own exposure was exactly closed by its own close execution (or cleanly resolved as
zero) and that its exact residual entry and attributable native Partial children are not active.
Aggregate flatness SHALL NOT be required while a same-side sibling remains, and aggregate movement
alone SHALL NOT prove success. Incomplete or contradictory correlation or attribution SHALL produce
no `2xx`.

#### Scenario: Verified cycle-owned close is acknowledged
- **WHEN** own exposure and all own attributable orders satisfy the terminal postconditions
- **THEN** ABI returns the closed `trade_cycle_closed` response

#### Scenario: Same-side sibling remains compatible with success
- **WHEN** the requested cycle's own postconditions pass while a sibling keeps same-side aggregate
  exposure and its own orders active
- **THEN** ABI may return `trade_cycle_closed` without mutating the sibling

#### Scenario: Incomplete own evidence blocks success
- **WHEN** own close execution, entry neutralization, child cleanup, or correlation is incomplete or
  contradictory
- **THEN** ABI returns no `2xx`

### Requirement: Both endpoints reuse a shared, closed error vocabulary
Both endpoints SHALL use the closed envelope `{ error: { code, message, details? } }`. The V1 mapping
SHALL be exactly:

| HTTP | Public error code | Endpoint |
|---:|---|---|
| 400 | `malformed_json` | both |
| 415 | `unsupported_media_type` | both |
| 422 | `validation_failed` | both |
| 422 | `unknown_trade_cycle_binding` | both |
| 422 | `unsupported_exchange_scope` | both |
| 422 | `position_not_open` | protection only |
| 422 | `close_execution_incomplete` | close only |
| 500 | `internal_error` | both |

`shared_scope_protection_unsupported` SHALL NOT be returned: a valid same-side shared owner is handled
by cycle-attributable native protection. No response SHALL expose stack traces, internal exceptions,
signatures, credentials, or raw exchange details, and no failure SHALL be serialized as success.

#### Scenario: Unknown pair is rejected on either endpoint
- **WHEN** the requested pair has no known binding
- **THEN** ABI returns HTTP `422` with `error.code` `unknown_trade_cycle_binding`

#### Scenario: Shared-scope protection uses normal lifecycle
- **WHEN** protection is requested for a valid cycle among multiple same-side active owners
- **THEN** ABI does not return `shared_scope_protection_unsupported`
- **AND** it applies the same native lifecycle used for a sole owner

#### Scenario: Fail-closed exchange ambiguity remains internal
- **WHEN** exact own attribution or exchange confirmation is ambiguous
- **THEN** ABI returns `internal_error` without raw exchange or secret-bearing details
