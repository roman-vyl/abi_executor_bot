# protection-execution Specification

## Purpose
Define how ABI executes a validated `PUT .../protection` command against Bybit for one
Runtime-owned `(strategy_instance_id, trade_cycle_id)` pair: resolving and re-verifying the pair's
owned physical scope, confirming a live position exists, writing the new stop/take, and verifying
the write by read-back before reporting success.

## Requirements

### Requirement: Resolution starts from the pair's own correlation record
ABI SHALL resolve a protection command using
`EntryPackageCorrelationRepository.get(strategy_instance_id, trade_cycle_id)`. A missing record
SHALL return `unknown_trade_cycle_binding` without any exchange call.

#### Scenario: No record fails closed
- **WHEN** no correlation record exists for the requested pair
- **THEN** ABI returns `unknown_trade_cycle_binding`
- **AND** ABI makes no exchange call

### Requirement: The resolved record's scope ownership is independently re-verified before any exchange call
ABI SHALL check that `findOwnerByScope(record.exchange_category, record.exchange_symbol)` — the same
ownership index `position-scope-exclusivity` maintains — identifies exactly the requesting pair as
current owner, evaluated independently rather than inferred from the record's mere existence. Any
other outcome (a different pair, or no owner) SHALL return `internal_error` without any exchange
call.

#### Scenario: Confirmed self-ownership proceeds
- **WHEN** the resolved record's scope is currently owned by the requesting pair itself
- **THEN** ABI proceeds to the live-position check

#### Scenario: A mismatch fails closed rather than proceeding on trust
- **WHEN** the resolved record's scope is owned by a different pair, or by no pair, according to the
  ownership index
- **THEN** ABI returns `internal_error`
- **AND** ABI makes no exchange call

### Requirement: A live position must be confirmed before any protection write
ABI SHALL confirm a live Bybit position exists for the pair's owned scope before sending any
protection write, reusing `open-position-resolution`'s existing live-position determination rather
than a second, independently validated query path.

#### Scenario: Durably closed record fails closed without a live query
- **WHEN** the record's status durably proves no position exists (per `open-position-resolution`'s
  durably-closed bucket)
- **THEN** ABI returns `position_not_open`
- **AND** ABI does not query the exchange

#### Scenario: Non-linear scope is rejected
- **WHEN** the resolved scope's category is not `linear`
- **THEN** ABI returns `unsupported_exchange_scope`
- **AND** ABI makes no protection write

#### Scenario: Live query reports no open position
- **WHEN** a live Bybit query for the pair's owned scope reports no position with size greater than
  zero
- **THEN** ABI returns `position_not_open`
- **AND** ABI makes no protection write

#### Scenario: Live query reports an open position
- **WHEN** a live Bybit query for the pair's owned scope reports an open, side-matching position
- **THEN** ABI proceeds to send the protection write

#### Scenario: A live-query failure fails closed
- **WHEN** the live position query fails for any reason `open-position-resolution` itself treats as
  a query failure
- **THEN** ABI returns `internal_error`
- **AND** ABI makes no protection write

### Requirement: The protection write replaces both legs together
ABI SHALL send the accepted `stop_price` and `take_price` as a single write covering both legs of
the position's protection, scoped to the pair's own owned `(category, symbol)` and its one-way
position slot. A `take_price` of `null` SHALL be sent as "no take-profit leg", clearing any
previously set take-profit rather than leaving it unchanged.

#### Scenario: Both legs are written together
- **WHEN** ABI sends the protection write
- **THEN** the write targets exactly the pair's own owned scope and position slot
- **AND** both the stop-loss and take-profit legs are included in that single write

#### Scenario: A null take_price clears the take-profit leg
- **WHEN** the accepted request's `take_price` is `null`
- **THEN** the protection write clears any take-profit leg rather than leaving a prior value in
  place

### Requirement: A protection write is never reported applied unless live execution actually ran
ABI SHALL NOT report `protection_applied` when the write was skipped because live execution is
disabled (dry-run, live trading disabled, missing credentials, or a disallowed exchange
environment) — the same live-execution guard entry-package execution already enforces.

#### Scenario: A skipped live write fails closed
- **WHEN** the deployment's live-execution guard reports live execution is not permitted
- **THEN** ABI returns `internal_error`
- **AND** ABI does not report `protection_applied`

### Requirement: Success requires a read-back that reconfirms the applied values by live query
After sending the protection write, ABI SHALL re-query the pair's owned scope's live position and
verify, by exact-decimal numeric comparison, that the confirmed stop-loss and take-profit equal the
accepted request values before returning `protection_applied`. This read-back SHALL be a fresh query
made after the write, never the live-position check performed before it.

#### Scenario: Verified read-back allows success
- **WHEN** the read-back query's confirmed stop-loss and take-profit are numerically equal to the
  accepted request values
- **THEN** ABI returns `protection_applied` with the accepted request's exact strings

#### Scenario: A read-back mismatch blocks success
- **WHEN** the read-back query's confirmed stop-loss or take-profit differs numerically from the
  accepted request values
- **THEN** ABI does not return `protection_applied` or any other `2xx`

#### Scenario: A read-back query failure blocks success
- **WHEN** the read-back query itself fails
- **THEN** ABI does not return `protection_applied` or any other `2xx`

### Requirement: Protection execution does not claim, release, or otherwise mutate scope ownership
ABI SHALL treat protection execution as a read of the existing ownership index, never a write to it.
Applying protection SHALL NOT change which pair owns the resolved scope, and SHALL NOT append any
record to the correlation store.

#### Scenario: Scope ownership is unchanged by a protection write
- **WHEN** ABI successfully applies protection for a pair
- **THEN** that pair's ownership of its scope is unchanged
- **AND** no new correlation record is written as a result

### Requirement: Protection commands for one pair serialize against that pair's other in-flight commands
ABI SHALL serialize a protection command against any concurrent entry-package command
(create/replace/cancel) for the same `(strategy_instance_id, trade_cycle_id)` pair, using the same
per-pair serialization key entry-package execution already uses, so neither can observe the other's
partial state (e.g. a stale `exchange_symbol` mid-REPLACE).

#### Scenario: Protection waits for an in-flight entry-package command on the same pair
- **WHEN** a protection command and an entry-package command for the same pair are submitted
  concurrently
- **THEN** ABI processes them one at a time, never interleaved, for that pair

#### Scenario: Different pairs are never serialized against each other by this rule
- **WHEN** protection commands for two different pairs are submitted concurrently
- **THEN** ABI processes them independently, without either waiting on the other
