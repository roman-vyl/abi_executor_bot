## Context

Runtime sends ABI one desired entry-package state consisting of its ownership identities, ticker, `DesiredEntry | null`, and a required positive exact-decimal `risk_multiplier`. ABI owns the HTTP representation of that command, but Runtime owns the format and meaning of the transmitted Runtime entities.

This change therefore defines only the public HTTP contract: request decoding, transport validation, success/error serialization, OpenAPI, and contract tests. Connection to executor, sizing, risk, exchange, journal, or intent workflows remains a separate change.

## Goals / Non-Goals

**Goals:**

- Fix one HTTP method and versioned route.
- Define closed request, applied-success, absent-success, and error DTOs.
- Preserve Runtime values without ABI normalization or additional semantic constraints.
- Make `2xx` acknowledgement mean the complete package was applied or its absence was confirmed.
- Define transport-only validation and safe handling of unknown failures.

**Non-Goal:** Internal ABI execution implementation is outside this change.

## Decisions

### Use one desired-state PUT resource

```text
PUT /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/entry-package
Content-Type: application/json
```

The path carries the Runtime ownership pair. The body carries:

```json
{
  "ticker": "BTCUSDT.P",
  "desired_entry": {
    "side": "long",
    "source_plan_bar_open_time_ms": 1785000000000,
    "planned_entry_price": "100000",
    "initial_stop_price": "99000",
    "initial_take_price": "103000",
    "locked_exit_profile": "runner"
  },
  "risk_multiplier": "1"
}
```

Absence of a desired package uses the same route:

```json
{
  "ticker": "BTCUSDT.P",
  "desired_entry": null,
  "risk_multiplier": "1"
}
```

All three body fields are required. `desired_entry` is nullable; `risk_multiplier` is always a positive exact-decimal string because it belongs to strategy-instance configuration and does not depend on whether a desired entry is present. Objects are closed; unknown fields are invalid.

### Validate Runtime-owned values without redefining them

`strategy_instance_id`, `trade_cycle_id`, and `ticker` are opaque non-empty strings. ABI applies no regex, length limit, canonicalization, case conversion, UUID constraint, or derivation rule and passes their decoded values onward unchanged.

A non-null `DesiredEntry` has exactly these required non-null fields:

- `side`: `long | short`;
- `source_plan_bar_open_time_ms`: JSON integer;
- `planned_entry_price`: exact-decimal text;
- `initial_stop_price`: exact-decimal text;
- `initial_take_price`: positive exact-decimal text;
- `locked_exit_profile`: string.

`risk_multiplier` is positive exact-decimal text. Exact-decimal values are JSON strings validated without binary floating-point conversion and passed unchanged. ABI adds no price-order rule, positivity rule for entry/stop, timestamp range, string-length limit, or decimal regex.

### Keep acknowledgements minimal

Complete package application or replacement returns HTTP `200`:

```json
{
  "strategy_instance_id": "runtime-owned-instance-id",
  "trade_cycle_id": "runtime-owned-cycle-id",
  "status": "entry_package_applied",
  "applied_desired_entry": {
    "side": "long",
    "source_plan_bar_open_time_ms": 1785000000000,
    "planned_entry_price": "100000",
    "initial_stop_price": "99000",
    "initial_take_price": "103000",
    "locked_exit_profile": "runner"
  },
  "accepted_risk_multiplier": "1",
  "calculated_quantity": "0.001"
}
```

This acknowledgement means the indivisible package `entry + initial stop + initial take` was applied and is now the acknowledged ABI state. Partial application cannot return this DTO or any other `2xx`.

Confirmed desired-state absence returns HTTP `200`, whether the package was removed during this request or was already absent:

```json
{
  "strategy_instance_id": "runtime-owned-instance-id",
  "trade_cycle_id": "runtime-owned-cycle-id",
  "status": "entry_package_absent"
}
```

The contract exposes no exchange order references, execution status, exchange payload, or operation sequence.

### Limit V1 errors to the HTTP boundary

Every error uses:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "request validation failed",
    "details": [
      {
        "path": "/desired_entry/initial_take_price",
        "message": "field is required"
      }
    ]
  }
}
```

`details` is required and non-empty only for `validation_failed`; otherwise it is omitted. Body paths use JSON Pointer, and path parameters use `/path/strategy_instance_id` or `/path/trade_cycle_id`.

The closed V1 mapping is:

| HTTP | Public code |
|---:|---|
| 400 | `malformed_json` |
| 415 | `unsupported_media_type` |
| 422 | `validation_failed` |
| 500 | `internal_error` |

Any failure not covered by transport validation, including a partial package outcome, is returned as safe `500 internal_error` until a later implementation change defines justified public application errors. No failure is converted to success, and internal exception details are not exposed.

### Keep implementation work at the transport layer

Future work in this change is limited to DTOs, schemas, route matching, request validation, response/error serialization, OpenAPI, and contract-level tests. It does not choose an internal application interface or connect the endpoint to execution workflows.

## Risks / Trade-offs

- [ABI receives opaque Runtime values] → Validate only the existing source-contract invariants and preserve values unchanged.
- [The initial error taxonomy is intentionally small] → Add public application errors only alongside the later implementation that can define their semantics.
- [A partial package must never look successful] → Permit `2xx` only for complete applied or confirmed absent acknowledgements.

## Migration Plan

The future transport layer is additive. Production workflow wiring is deferred to a separate approved change. No data or exchange-state migration is part of this contract.

## Open Questions

None for the scoped transport contract.
