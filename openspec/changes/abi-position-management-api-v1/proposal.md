## Why

Runtime can currently only tell ABI about a *desired entry* (`abi-entry-package-api`) and read the
*current* position state (`abi-open-position-lookup-api`). Once a position is open, Runtime has no
way to tell ABI "protect it differently" or "close it" — every such action today would require
either a new entry-package write (wrong semantics) or manual/out-of-band exchange access. This
change defines the public V1 HTTP contract for the two synchronous position-management commands
Runtime needs against an already-open position, addressed by the same `strategy_instance_id` +
`trade_cycle_id` ownership pair already used by the other two endpoints.

## What Changes

- Add `PUT .../protection`: replace the position's protective stop/take state.
- Add `DELETE .../open-position`: close the trade cycle's entire current position and remove every
  exchange order ABI can attribute to that ownership pair.
- Define request/response DTOs, a closed error-code set, and an HTTP status mapping for both.
- Fix the meaning of `2xx`: it is returned only once ABI has verified the requested outcome against
  the exchange, never merely because a write was accepted.
- Fix the meaning of "close": always the full current remainder, with no quantity/percentage input:
  ABI determines the remaining size itself and clears only orders it can attribute to this pair.
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
- Trading safety: a write that was merely accepted/submitted/queued by the exchange can never be
  reported to Runtime as success.
