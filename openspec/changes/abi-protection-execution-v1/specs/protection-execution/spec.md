# protection-execution Specification

## Purpose
Define how ABI executes a validated `PUT .../protection` command for one Runtime-owned
`(strategy_instance_id, trade_cycle_id)` pair: confirming the pair still owns a live position before
touching Bybit, writing the new stop/take, and verifying the write by read-back before reporting
success.

## Requirements

### Requirement: The pair is classified before any exchange call
ABI SHALL resolve, in this order and before any exchange call: an unknown pair returns
`unknown_trade_cycle_binding`; a known pair whose record already durably proves no position exists
(the same durable-absence condition `position-scope-exclusivity` treats as releasing that pair's
scope) returns `position_not_open` directly, with no ownership check — such a pair's scope may
already be owned by someone else, so ownership must not be checked first. Every other pair SHALL have
its ownership of the scope its own record names independently reconfirmed via the current
scope-ownership state `position-scope-exclusivity` maintains, not inferred from the record's mere
existence; any outcome other than this exact pair owning that scope returns `internal_error`.

#### Scenario: Unknown pair fails closed
- **WHEN** no correlation record exists for the requested pair
- **THEN** ABI returns `unknown_trade_cycle_binding`

#### Scenario: Durably absent pair skips the ownership check
- **WHEN** the requested pair's record durably proves no position exists
- **THEN** ABI returns `position_not_open` without checking scope ownership

#### Scenario: Confirmed self-ownership proceeds
- **WHEN** a non-durably-absent pair currently owns the scope its own record names
- **THEN** ABI proceeds to the live-position check

#### Scenario: An ownership mismatch fails closed
- **WHEN** the scope named by a non-durably-absent pair's record is owned by a different pair, or by
  no pair
- **THEN** ABI returns `internal_error`

### Requirement: A live position must be confirmed before any write, using the existing resolution logic
ABI SHALL determine whether a live position exists for the pair's owned scope by delegating entirely
to `open-position-resolution`'s existing determination (category restriction, query validation, side
match) rather than a second implementation. Only a confirmed open position proceeds to the write;
every other outcome maps directly to the matching protection error (`position_not_open`,
`unsupported_exchange_scope`, or `internal_error`) and sends no write.

#### Scenario: A confirmed open position proceeds to the write
- **WHEN** `open-position-resolution`'s determination for the pair's owned scope is an open position
- **THEN** ABI proceeds to send the protection write

#### Scenario: Any other determination blocks the write
- **WHEN** that determination is closed, unsupported, or a query failure
- **THEN** ABI returns the matching protection error and sends no write

### Requirement: The protection write replaces both legs together
ABI SHALL send the accepted `stop_price` and `take_price` as a single write covering both legs,
scoped to the pair's own owned scope. An accepted `take_price` of `null` SHALL clear any previously
set take-profit leg rather than leaving it unchanged.

#### Scenario: A null take_price clears the take-profit leg
- **WHEN** the accepted request's `take_price` is `null`
- **THEN** the single write includes both legs, and clears any existing take-profit leg

### Requirement: Success requires both a live write and a verified read-back
ABI SHALL NOT report `protection_applied` when the write was skipped by the live-execution guard
entry-package execution already enforces. When the write was sent, ABI SHALL re-query the pair's
owned scope over a bounded number of fresh attempts — never resending the write — and verify, by
exact-decimal numeric comparison, that the confirmed stop-loss and take-profit equal the accepted
request values (a confirmed leg reading as numeric zero satisfies an accepted `take_price: null`)
before returning `protection_applied`.

#### Scenario: A skipped live write fails closed
- **WHEN** the live-execution guard reports live execution is not permitted
- **THEN** ABI returns `internal_error` and does not report `protection_applied`

#### Scenario: Verified read-back allows success
- **WHEN** a read-back attempt's confirmed values are numerically equal to the accepted request
  values
- **THEN** ABI returns `protection_applied` with the accepted request's exact strings

#### Scenario: Read-back exhausts its attempts without confirming
- **WHEN** every read-back attempt fails to confirm the accepted values, or the read-back query
  itself fails
- **THEN** ABI does not return `protection_applied` or any other `2xx`

### Requirement: Execution boundaries: no state mutation, and per-pair serialization
Applying protection SHALL NOT change which pair owns the resolved scope and SHALL NOT write any
record to the correlation store. ABI SHALL serialize a protection command against any concurrent
entry-package command (create/replace/cancel) for the same pair, so neither observes the other's
partial state; protection commands for different pairs SHALL NOT be serialized against each other.

#### Scenario: State is unchanged by a protection write
- **WHEN** ABI successfully applies protection for a pair
- **THEN** that pair's scope ownership is unchanged and no correlation record is written

#### Scenario: Same-pair commands never interleave
- **WHEN** a protection command and an entry-package command for the same pair are submitted
  concurrently
- **THEN** ABI processes them one at a time for that pair, and no different pair waits on either
