## ADDED Requirements

### Requirement: ABI exposes an entry-remainder cancel endpoint
ABI SHALL expose `POST /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/entry-remainder/cancel`, accepting `application/json` (optional UTF-8 charset) and returning `application/json; charset=utf-8`. The body SHALL be a closed, empty JSON object `{}`. The path identifiers SHALL follow the same opaque-value rules as the entry-package endpoint. A malformed body SHALL be rejected before any durable read decision or exchange call.

#### Scenario: Empty object body is accepted
- **WHEN** a client sends `POST .../entry-remainder/cancel` with body `{}` and a supported JSON content type
- **THEN** ABI processes the request through the entry-remainder cancel boundary

#### Scenario: Any other body is rejected
- **WHEN** the body is not a JSON object, or contains any field
- **THEN** ABI returns HTTP `422` with `error.code` `validation_failed` and makes no exchange call

#### Scenario: Malformed JSON or content type is rejected
- **WHEN** the body is not valid JSON, or the content type is not JSON
- **THEN** ABI returns `400 malformed_json` or `415 unsupported_media_type` respectively

### Requirement: The parent entry order is found only through the pair's correlation
ABI SHALL resolve the request to the correlation record of the exact pair `strategy_instance_id` + `trade_cycle_id` and SHALL act only on that record's current entry order identity (`order_link_id`). The request carries no exchange identifier. ABI SHALL NOT act on any order of another pair, on an earlier generation from `binding_history`, or use a symbol-wide or account-wide cancel.

#### Scenario: Unknown pair is rejected
- **WHEN** no correlation record exists for the pair
- **THEN** ABI returns HTTP `422` with `error.code` `unknown_trade_cycle_binding` and makes no exchange call

#### Scenario: Missing current entry identity is contradictory
- **WHEN** the pair's record has a captured first fill but no current `order_link_id`
- **THEN** ABI returns HTTP `500` with `error.code` `internal_error` and makes no exchange call

#### Scenario: Only the pair's own current order is addressed
- **WHEN** another pair on the same symbol has a live entry order
- **THEN** ABI neither queries nor cancels that order

### Requirement: The operation applies only after the entry has a captured first fill
ABI SHALL accept the operation only for a record whose `first_fill_at_ms` is non-null. For any other record ABI SHALL return HTTP `422` with `error.code` `entry_not_filled` and make no exchange call; cancelling an unfilled entry remains the entry-package `CANCEL`.

#### Scenario: Unfilled entry is refused
- **WHEN** the pair's record has `first_fill_at_ms` null
- **THEN** ABI returns HTTP `422` with `error.code` `entry_not_filled`
- **AND** ABI makes no exchange call

### Requirement: A live remainder is cancelled and confirmed terminal; a terminal order is left alone
For an accepted request ABI SHALL classify the current entry order with fresh reads. When it is already terminal (fully filled, cancelled, or any other terminal status) ABI SHALL send no cancel. When it is live (including partially filled) ABI SHALL send one cancel for that order's own `orderLinkId` through the live-execution guard and then confirm, over the same bounded fresh attempts close uses, that the order reached a terminal status. Terminality SHALL be decided by the order status, never by whether quantity was executed. A record with status `terminal_closed` SHALL be answered as already terminal without any exchange call.

#### Scenario: Partially filled live order is cancelled
- **WHEN** the current entry order is `PartiallyFilled`
- **THEN** ABI sends one cancel for that order's `orderLinkId`
- **AND** after the order is confirmed terminal ABI returns `entry_remainder_cancelled`

#### Scenario: Fully filled order needs no cancel
- **WHEN** the current entry order is already `Filled`
- **THEN** ABI sends no cancel and returns `entry_order_already_terminal`

#### Scenario: Closed cycle is answered from the record
- **WHEN** the pair's record status is `terminal_closed`
- **THEN** ABI returns `entry_order_already_terminal` with `executed_quantity` null and makes no exchange call

#### Scenario: Unconfirmed outcome fails closed
- **WHEN** a query fails, the cancel is not acknowledged or is skipped by the live-execution guard, or the order is not confirmed terminal within the bounded attempts
- **THEN** ABI returns HTTP `500` with `error.code` `internal_error`

#### Scenario: Repeated request after success
- **WHEN** the same pair is requested again after `entry_remainder_cancelled`
- **THEN** ABI sends no cancel and returns `entry_order_already_terminal`

### Requirement: The operation never touches the position or its protection
ABI SHALL NOT read or close the position, place any order, or cancel, amend, or re-attribute any native Partial stop-loss or take-profit child as part of this operation, and SHALL NOT write the correlation record.

#### Scenario: Protection children survive the cancel
- **WHEN** ABI cancels the remainder of a partially filled entry that has native stop and take children
- **THEN** ABI sends no request addressing those children or the position

#### Scenario: Correlation record is unchanged
- **WHEN** the operation completes with any answer
- **THEN** the pair's correlation record is byte-for-byte the same as before the request

### Requirement: Success is a closed object
A success SHALL be HTTP `200` with a closed JSON object containing exactly `strategy_instance_id`, `trade_cycle_id`, `status` (`entry_remainder_cancelled` | `entry_order_already_terminal`) and `executed_quantity` (exact-decimal text of the entry order's confirmed executed quantity, or `null` only for a `terminal_closed` record).

#### Scenario: Cancelled answer carries the executed quantity
- **WHEN** ABI cancels a remainder after `0.004` of `0.010` was executed
- **THEN** the answer is `status` `entry_remainder_cancelled` with `executed_quantity` `"0.004"`

### Requirement: The operation is serialized with other writes of the same pair
The handler SHALL run under the same pair-level lock as entry-package, protection, and close for that pair, so it never interleaves with another write operation of the same pair.

#### Scenario: Concurrent close of the same pair waits
- **WHEN** a close request for the same pair is in progress
- **THEN** the entry-remainder cancel starts only after the close has finished

### Requirement: OpenAPI describes the operation
ABI SHALL describe the operation in its OpenAPI position-management document with the route, request and response schemas and the error mapping: `400 malformed_json`, `415 unsupported_media_type`, `422 validation_failed`, `422 unknown_trade_cycle_binding`, `422 entry_not_filled`, `500 internal_error`.

#### Scenario: OpenAPI and contract tests agree
- **WHEN** the OpenAPI document and contract tests are validated
- **THEN** the operation's schemas and error mapping match this capability
