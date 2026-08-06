## Context

Runtime already addresses an entry package and an open-position read by the same
`strategy_instance_id` + `trade_cycle_id` pair (`abi-entry-package-api`, `abi-open-position-lookup-api`).
This change adds the two remaining synchronous position-management commands Runtime needs against
an already-open position under that same pair, and defines only their public HTTP contract —
transport shape, DTOs, and what a `2xx` is allowed to mean. It does not choose how ABI internally
confirms a write against the exchange or attributes an order to a trade cycle; those stay
implementation, deferred the same way `entry-package-execution` was deferred from
`abi-entry-package-api`.

## Goals / Non-Goals

**Goals:**
- Fix two HTTP methods/routes under the existing pair-scoped path prefix.
- Define closed request/response DTOs for both.
- Make `2xx` mean "verified against the exchange", never "write accepted".
- Make "close" mean "100% of the current remainder, plus every order this pair owns" by construction
  — no quantity/percentage field exists to say otherwise.
- Reuse the existing error envelope and error-code vocabulary; add only what's genuinely new.

**Non-Goal:** Internal ABI execution (exchange calls, order-attribution mechanics, retries, pending
state, partial close, webhook-driven external-close detection) is outside this change.

## Decisions

### 1. Two pair-scoped resources, reusing the existing `open-position` noun

```text
PUT    /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/protection
DELETE /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position
```

`protection` is a new resource: `PUT` replaces the position's whole protective state (not an
incremental patch), matching the entry-package endpoint's full-replacement style. `DELETE` targets
the same `open-position` resource `abi-open-position-lookup-api` already reads with `GET` —
deleting it means closing the position it describes, so no new noun is needed. `DELETE` carries no
body: the absence of any quantity/percentage/fraction field is what makes "always 100%" a property
of the shape, not a rule Runtime has to remember to follow.

### 2. Protection request/response

```json
// PUT .../protection
{ "stop_price": "99000", "take_price": "103000" }
```

`stop_price` is required, non-null, exact-decimal text. `take_price` is exact-decimal text or
`null` — omitting take-profit protection is a supported state, not an error. Object is closed.

```json
// 200
{
  "strategy_instance_id": "runtime-owned-instance-id",
  "trade_cycle_id": "runtime-owned-cycle-id",
  "status": "protection_applied",
  "stop_price": "99000",
  "take_price": "103000"
}
```

`protection_applied` SHALL mean ABI has verified `stop_price`/`take_price` are the position's actual
current protection. Accepted/submitted/queued exchange state is not this status and does not
produce any `2xx`.

### 3. Close response

```json
// 200, no request body
{
  "strategy_instance_id": "runtime-owned-instance-id",
  "trade_cycle_id": "runtime-owned-cycle-id",
  "status": "trade_cycle_closed"
}
```

`trade_cycle_closed` SHALL mean ABI has verified both: the pair's open position quantity is zero,
and no order ABI can attribute to this exact pair remains active. "Attributable to this pair"
excludes any order ABI cannot tie to this `strategy_instance_id` + `trade_cycle_id` — same-symbol or
same-account orders belonging to anything else are never touched and never block this check. ABI
performs and verifies this cleanup even when no position is currently open (already-closed is not a
shortcut to skip verifying leftover orders), so repeated `DELETE` calls are safe.

### 4. Error taxonomy: reuse first, add one new code

Both endpoints reuse the existing envelope (`{ error: { code, message, details? } }`) and reuse
`validation_failed`/`internal_error` from `abi-entry-package-api` and `unknown_trade_cycle_binding`
from `abi-open-position-lookup-api` for "this pair has no known binding at all". `internal_error`
also covers every exchange-derived or ambiguous failure that would otherwise require guessing —
same fail-closed discipline the other two contracts already use, not a new one invented here.

| HTTP | Public code | Applies to |
|---:|---|---|
| 400 | `malformed_json` | PUT only |
| 415 | `unsupported_media_type` | PUT only |
| 422 | `validation_failed` | both |
| 422 | `unknown_trade_cycle_binding` | both (reused) |
| 500 | `internal_error` | both (reused) |

No new business code is minted for "could not confirm the write" — it is exchange-derived
uncertainty and falls into `internal_error`, exactly like every other unresolved case in the two
existing contracts.

## Risks / Trade-offs

- [Reusing `open-position` as the `DELETE` target couples this contract's route naming to the lookup
  endpoint's] → Accepted: it removes a naming decision and keeps one noun per resource concept.
- [No dedicated code distinguishes "write rejected" from "write accepted but unconfirmed"] →
  Accepted for V1, consistent with the other two contracts' existing `internal_error` catch-all.

## Migration Plan

Additive only; no existing route, DTO, or stored state changes. Production wiring is a separate,
later change.

## Open Questions

None for the scoped transport contract.
