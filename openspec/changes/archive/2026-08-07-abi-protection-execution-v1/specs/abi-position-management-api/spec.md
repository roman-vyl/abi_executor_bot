## MODIFIED Requirements

### Requirement: ABI exposes a protection endpoint
ABI SHALL expose `PUT /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/protection`, accepting `application/json` and returning `application/json; charset=utf-8`. The body SHALL be a closed JSON object with exactly `stop_price` (required, non-null, strictly positive exact-decimal text) and `take_price` (strictly positive exact-decimal text, or `null`). Zero and negative values SHALL be rejected for both fields: Bybit's own protection-clearing command reserves the numeric value zero to mean "remove this leg," so accepting zero as a real price at this public boundary would let a caller silently strip protection while ABI still reports `protection_applied`.

#### Scenario: Valid protection request is accepted
- **WHEN** `stop_price` is strictly positive exact-decimal text and `take_price` is strictly positive exact-decimal text or `null`
- **THEN** ABI processes the request through the protection HTTP boundary

#### Scenario: Missing or malformed price field is rejected
- **WHEN** `stop_price` is missing, null, not valid exact-decimal text, or not strictly positive, or `take_price` is present, non-null, and either not valid exact-decimal text or not strictly positive
- **THEN** ABI returns HTTP `422` with `error.code` `validation_failed` identifying the offending field

#### Scenario: Zero is rejected as a real price
- **WHEN** `stop_price` or a non-null `take_price` is exactly zero
- **THEN** ABI returns HTTP `422` with `error.code` `validation_failed`, the same as any other malformed price
