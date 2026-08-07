## Why

Runtime already computes `ApplyProtection` and calls ABI's `PUT
/v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/protection`, but the
route ends in a stub: any transport-valid request unconditionally returns `internal_error` without
resolving a scope, querying Bybit, or writing anything. Runtime can never converge
`latest_confirmed_management_protection` because ABI never returns anything but a fabricated failure.

`abi-position-scope-exclusivity-v1` closed the precondition this needed: ABI now guarantees at most
one `(strategy_instance_id, trade_cycle_id)` pair owns a given physical scope at a time. Protection
execution can now safely translate "apply protection for A/A1" into "write to Bybit's BTCUSDT
position" — first proving BTCUSDT is A/A1's own scope, not merely that A/A1 once had a BTC binding.

## What Changes

- Wire `PUT .../protection` to real execution: confirm the pair still owns a live position, write the
  new stop/take to Bybit, and verify it took effect by read-back before acknowledging success. The
  internal mechanics are defined in the new `protection-execution` capability (design.md, spec.md).
- Reuse existing infrastructure rather than adding new surface: the live-position determination
  already built for `GET .../open-position`, the same per-pair serialization lock entry-package
  execution uses, and the existing readiness gate. No new lock, no new correlation-store write.
- Tighten the public contract: `stop_price` and a non-null `take_price` must be strictly positive
  exact-decimal text; zero and negative values are rejected as `validation_failed`. This closes a gap
  the stub had hidden — Bybit's own trading-stop command uses zero to mean "remove this leg," so a
  request of `stop_price: "0"` would otherwise let a caller silently strip both legs of protection
  while ABI still reports `protection_applied`.

Non-goals: `DELETE .../open-position` stays a transport-only stub; releasing a physical scope after a
fill stays deferred to a future close-execution change; no shared/virtual scope ownership; no command
IDs or new retry/idempotency architecture; no new durable field on `EntryPackageExecutionRecord`
(Runtime owns `latest_confirmed_management_protection`, not ABI).

## Capabilities

### New Capabilities
- `protection-execution`: how ABI executes an already-contracted `PUT .../protection` request.

### Modified Capabilities
- `abi-position-management-api`: `stop_price`/`take_price` validation now requires strictly positive
  exact-decimal text (zero and negative rejected), for the reason above. No other part of this
  capability's contract (route, response shapes, other error codes) changes.

## Impact

- Public HTTP contract: one validation tightening (above); otherwise unchanged — same route, same
  response DTOs, same error codes. A request that previously sent `stop_price: "0"` now receives
  `validation_failed` instead of the stub's unconditional `internal_error`.
- Correlation store: unchanged on-disk shape and write path — protection execution reads the existing
  record and never writes to the correlation store.
- Trading safety: every write is preceded by an ownership re-check and a live-position check, and
  followed by a bounded read-back, before success is ever reported; zero is never accepted as a real
  price, closing the silent-strip gap above.
- Dry-run / live guard: identical gating to entry-package execution (`ABI_DRY_RUN=false`,
  `ABI_LIVE_TRADING_ENABLED=true`, both Bybit credentials configured, non-mainnet `BYBIT_ENV`).
  Protection is never reported applied unless a live write actually happened and was verified.
