## Why

Runtime can currently only tell ABI about a *desired entry* (`abi-entry-package-api`) and read the
*current* position state (`abi-open-position-lookup-api`). Once a position is open, Runtime has no
way to tell ABI "protect it differently" or "close it". This change defines the public V1 HTTP
contract for the two synchronous position-management commands Runtime needs against an
already-open position, addressed by the same `strategy_instance_id` + `trade_cycle_id` ownership
pair already used by the other two endpoints.

## What Changes

- Add `PUT .../protection`: replace the position's protective stop/take state.
- Add `DELETE .../open-position`, accepting only an absent/empty body: close the trade cycle's
  entire current position and remove every exchange order ABI can attribute to that ownership pair.
- Fix `2xx` to mean "exchange-verified", never "write accepted": protection confirmation requires
  exact-decimal numeric equality to the requested values, and the response always echoes the
  canonical requested/pair values, never an exchange-normalized one.
- Fix typed failures beyond the existing `validation_failed`/`internal_error`: reuse
  `unknown_trade_cycle_binding` and `unsupported_exchange_scope` from `abi-open-position-lookup-api`
  on both endpoints; add `position_not_open` for a protection request against a pair with no live
  position.
- Require full close to proceed only under unambiguous pair ownership within the supported V1
  exchange scope; ambiguous, overlapping, or out-of-scope exposure is never closed, and another
  pair's orders are never cancelled.
- Add an OpenAPI 3.1 operation for each endpoint.

Non-goal: internal ABI execution (Bybit calls, adapter wiring, retries/recovery, order-attribution
mechanics, pending-state handling, partial close, webhook-driven external-close detection) is
outside this change, same split already used between `abi-entry-package-api` and
`entry-package-execution`.

## Capabilities

### New Capabilities

- `abi-position-management-api`: Defines the public V1 HTTP contract for applying protection to,
  and fully closing, an already-open Runtime-owned trade cycle position.

### Modified Capabilities

None.

## Impact

- Future public API: two new versioned routes with closed request/response/error schemas.
- Future ABI code: DTOs, transport validation, thin HTTP handlers, OpenAPI, contract-level tests —
  no execution wiring.
- Trading safety: a write that was merely accepted/submitted/queued can never be reported as
  success, and a position or order can never be closed/cancelled under ambiguous ownership.
