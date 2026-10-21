## ADDED Requirements

### Requirement: A CANCEL for an unknown pair writes a permanent recovery tombstone
When a PUT with `desired_entry: null` arrives for a pair with no correlation record, ABI
SHALL durably write `status: absent` with `mutation_fenced: true` under the pair lock
before returning `entry_package_absent`. Once true, `mutation_fenced` SHALL never be
cleared.

#### Scenario: Unknown pair is fenced
- **WHEN** a CANCEL arrives for a pair with no record
- **THEN** ABI durably writes `absent` with `mutation_fenced: true` and returns
  `entry_package_absent`

#### Scenario: Repeated CANCEL is idempotent
- **WHEN** a CANCEL arrives for a fenced pair
- **THEN** ABI returns `entry_package_absent` and writes nothing

### Requirement: A fenced pair refuses any non-null mutation
A PUT with a non-null desired entry for a pair whose record has `mutation_fenced: true`
SHALL return `500 internal_error` without any exchange request and without any
correlation write. An ordinary `absent` record without the flag keeps its existing
behavior.

#### Scenario: Delayed original PUT after the fence
- **WHEN** a non-null PUT for a fenced pair arrives after the CANCEL
- **THEN** ABI sends no exchange request, the record stays fenced `absent`, and the
  response is `500 internal_error`

#### Scenario: PUT queued behind the CANCEL on the pair lock
- **WHEN** the CANCEL holds the pair lock and a non-null PUT for the same pair waits
- **THEN** the PUT is refused after the CANCEL completes and no order is created

#### Scenario: Ordinary absent still allows a new generation
- **WHEN** a non-null PUT arrives for an `absent` record without `mutation_fenced`
- **THEN** ABI keeps the existing behavior and may start a new generation
