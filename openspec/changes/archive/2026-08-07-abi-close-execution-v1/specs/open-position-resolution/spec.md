## MODIFIED Requirements

### Requirement: Record status is classified into durably-closed, live-query-admissible, and unresolved buckets
ABI SHALL classify a found record's `status` into exactly one of three buckets before taking any
further action:

- Durably closed (`absent`, `terminal_unfilled`, `terminal_closed`): no live exchange query is made;
  the response is `position_open: false` directly.
- Live-query-admissible (`applied`, `pending_replace`, `pending_cancel`): a live Bybit query is
  required.
- Unresolved (`pending_create`, `create_failed`, `unknown`): ABI fails closed without attempting a
  live query.

#### Scenario: Absent record durably proves no exposure
- **WHEN** the record's status is `absent`
- **THEN** ABI returns `position_open: false` with both facts `null`
- **AND** ABI does not query the exchange

#### Scenario: Terminal-without-fill durably proves no exposure
- **WHEN** the record's status is `terminal_unfilled`
- **THEN** ABI returns `position_open: false` with both facts `null`
- **AND** ABI does not query the exchange

#### Scenario: Terminally-closed durably proves no exposure
- **WHEN** the record's status is `terminal_closed`
- **THEN** ABI returns `position_open: false` with both facts `null`
- **AND** ABI does not query the exchange

#### Scenario: Applied status requires a live query
- **WHEN** the record's status is `applied`
- **THEN** ABI proceeds to the live Bybit query rather than inferring fill state from the status alone

#### Scenario: Pending replace requires a live query
- **WHEN** the record's status is `pending_replace`
- **THEN** ABI proceeds to the live Bybit query using the record's existing `exchange_category`/`exchange_symbol`

#### Scenario: Pending cancel requires a live query
- **WHEN** the record's status is `pending_cancel`
- **THEN** ABI proceeds to the live Bybit query rather than assuming the cancel has already taken effect

#### Scenario: Unresolved status fails closed without querying
- **WHEN** the record's status is `pending_create`, `create_failed`, or `unknown`
- **THEN** ABI does not query the exchange
- **AND** ABI does not return `position_open: false`
- **AND** ABI returns `internal_error`
