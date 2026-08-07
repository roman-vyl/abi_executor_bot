## ADDED Requirements

### Requirement: A trade cycle terminally closed by close-execution is not silently resurrected
When a trade cycle's record is in the terminally-closed state `close-execution` establishes, ABI SHALL
treat it the same as a terminal-without-fill trade cycle for the purpose of refusing to create a new
order for it: a subsequent non-null `desired_entry` request SHALL NOT create a new order, and a
subsequent null `desired_entry` request SHALL acknowledge absence without altering that terminally-
closed record.

#### Scenario: Terminally-closed blocks a new entry
- **WHEN** a non-null `desired_entry` request is received for a trade cycle whose record is
  terminally closed
- **THEN** ABI SHALL NOT create a new order and SHALL return a safe internal error, the same
  treatment already given to a terminal-without-fill trade cycle

#### Scenario: A cancel-intent request against a terminally-closed trade cycle changes nothing
- **WHEN** a null `desired_entry` request is received for a trade cycle whose record is terminally
  closed
- **THEN** ABI SHALL acknowledge absence without reverting the record to any other status and without
  attempting to cancel an order that no longer exists
