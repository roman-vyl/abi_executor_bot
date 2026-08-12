## RENAMED Requirements
- FROM: `### Requirement: Success requires both a live write and a verified read-back`
- TO: `### Requirement: Success requires a verified desired protection state`

## MODIFIED Requirements

### Requirement: Success requires a verified desired protection state
ABI SHALL NOT report `protection_applied` when a write was attempted but skipped by the live-execution
guard entry-package execution already enforces. Success SHALL follow one of two paths:

- **Already satisfied**: after the live-position confirmation, if the confirmed exchange stop-loss and
  take-profit are already numerically equal (exact-decimal comparison, a confirmed leg reading as
  numeric zero satisfying an accepted `take_price: null`) to the accepted request values, ABI SHALL
  NOT send a protection write, and SHALL return `protection_applied` with the accepted request's exact
  strings. This path SHALL still fail closed under the live-execution guard: if live execution is not
  currently permitted, ABI returns `internal_error` even though the desired state already matches.
- **Update required**: when at least one requested leg differs, ABI SHALL send exactly one protection
  write, then re-query the pair's owned scope over a bounded number of fresh attempts — never
  resending the write — and verify, by exact-decimal numeric comparison, that the confirmed stop-loss
  and take-profit equal the accepted request values before returning `protection_applied`.

Both paths use the same exact-decimal equality semantics; ABI SHALL NOT special-case any particular
exchange response code to convert a rejected write into success.

#### Scenario: Already-equal confirmed protection is accepted without a write
- **WHEN** the live-position confirmation's confirmed stop-loss and take-profit are already
  numerically equal to the accepted request's `stop_price`/`take_price`
- **THEN** ABI sends no protection write and returns `protection_applied` with the accepted request's
  exact strings

#### Scenario: Already-equal confirmed protection still fails closed under the live-execution guard
- **WHEN** the confirmed protection already matches but the live-execution guard reports live
  execution is not permitted
- **THEN** ABI returns `internal_error`, sends no protection write, and does not report
  `protection_applied`

#### Scenario: Verified read-back allows success
- **WHEN** the confirmed stop-loss or take-profit differs from the accepted request values, a
  protection write is sent, and a read-back attempt's confirmed values are numerically equal to the
  accepted request values
- **THEN** ABI returns `protection_applied` with the accepted request's exact strings

#### Scenario: A skipped live write fails closed
- **WHEN** at least one leg differs and the live-execution guard reports live execution is not
  permitted
- **THEN** ABI returns `internal_error` and does not report `protection_applied`

#### Scenario: Read-back exhausts its attempts without confirming
- **WHEN** every read-back attempt after a write fails to confirm the accepted values, or the
  read-back query itself fails
- **THEN** ABI does not return `protection_applied` or any other `2xx`
