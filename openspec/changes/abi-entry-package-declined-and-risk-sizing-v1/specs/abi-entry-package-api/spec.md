## ADDED Requirements

### Requirement: Declined success refuses an entry before the exchange
An expected refusal of a first APPLY SHALL return HTTP `200` with a closed JSON
object containing exactly `strategy_instance_id`, `trade_cycle_id`, `status`
(literal `entry_package_declined`), `decline_reason`, and `decline_message`.
It SHALL mean that ABI sent nothing to the exchange for the pair and the pair
is durably closed.

#### Scenario: Declined body
- **WHEN** ABI declines an entry package
- **THEN** ABI returns HTTP `200` with exactly the five fields
- **AND** both identifiers are the exact decoded path values
- **AND** `decline_reason` is one of `insufficient_balance_for_minimum_quantity`, `quantity_above_exchange_maximum`, `invalid_stop_distance`, `margin_mode_not_supported`
- **AND** `decline_message` is non-empty safe text without secrets or stack traces

#### Scenario: Declined is never an answer to absence
- **WHEN** the PUT has `desired_entry: null`
- **THEN** ABI never returns `entry_package_declined`

#### Scenario: OpenAPI describes the declined DTO
- **WHEN** the OpenAPI operation is validated
- **THEN** its `200` response is a union of the applied, absent, and declined DTOs
