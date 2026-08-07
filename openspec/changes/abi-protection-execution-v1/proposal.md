## Why

Runtime already computes `ApplyProtection` and calls ABI's `PUT
/v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/protection`, but the
route ends in a stub: any transport-valid request unconditionally returns `internal_error`
(`positionManagementRoutes.ts::handleProtection`) without resolving a scope, querying Bybit, or
writing anything. Runtime can never converge `latest_confirmed_management_protection` because ABI
never returns anything but a fabricated failure.

`abi-position-scope-exclusivity-v1` closed the precondition this needed: ABI now guarantees at most
one `(strategy_instance_id, trade_cycle_id)` pair owns a given physical scope (`category` + `symbol`)
at a time. Protection execution can now safely translate "apply protection for A/A1" into "write to
Bybit's BTCUSDT position" — first proving BTCUSDT is A/A1's own scope, not merely that A/A1 once had
a BTC binding.

## What Changes

Wire `PUT .../protection` to a new `ProtectionApplicationService`, executing this ordered pipeline
for a validated command (full rationale in design.md):

1. Look up the pair's correlation record (`unknown_trade_cycle_binding` if none).
2. If the record already durably proves no position (the same durable-absence statuses
   `position-scope-exclusivity` treats as scope-released) → `position_not_open`, no exchange call.
3. Otherwise, independently re-confirm the record's own scope is still owned by this pair
   (`internal_error` on mismatch — a defense-in-depth check, not expected to ever trip).
4. Confirm Bybit currently reports a live position for that scope, reusing
   `open-position-resolution`'s existing live-query logic rather than a second query path.
5. Send Bybit's position-level trading-stop write for both legs together, gated by the same
   live-execution guard entry-package execution already uses.
6. Re-query (bounded, a few short-delay attempts, no repeated writes) and confirm by exact-decimal
   numeric comparison that the position now carries the requested stop/take before returning
   `protection_applied`.

Also:
- Extend the shared validated position-query row with the position's own stop-loss/take-profit as
  raw, optional data — read-back reuses the existing query path instead of a second one, without
  changing that query's existing pass/fail rules for its other caller (`GET .../open-position`).
- Serialize protection commands on the same per-pair `KeyedMutex` instance and key entry-package
  apply already uses, so a protection PUT can never race a concurrent create/replace/cancel for the
  same pair. The scope-level lock is not involved — protection neither claims nor releases a scope.
- Add capability spec `protection-execution` (parallel to `entry-package-execution` and
  `open-position-resolution`) for this internal pipeline. The public contract in
  `abi-position-management-api` is unchanged — it already specified this behavior; only the stub
  implementation is being replaced.

Non-goals: `DELETE .../open-position` stays a transport-only stub; releasing a physical scope after a
fill stays deferred to a future close-execution change; no shared/virtual scope ownership; no command
IDs or new retry/idempotency architecture — a repeated PUT simply re-runs the same pipeline; no new
durable field on `EntryPackageExecutionRecord` (Runtime owns `latest_confirmed_management_protection`,
not ABI).

## Capabilities

### New Capabilities
- `protection-execution`: how ABI executes an already-contracted `PUT .../protection` request.

### Modified Capabilities
None. `abi-position-management-api` already specifies this behavior; `position-scope-exclusivity`
and `open-position-resolution` are consumed unchanged.

## Impact

- Public HTTP contract, correlation-store shape, and write path: unchanged. Protection execution
  reads the existing record and never writes to the correlation store.
- Concurrency: reuses the existing per-pair `mutex`; no new lock; no change to
  `position-scope-exclusivity`'s acquisition/release rules.
- Trading safety: every write is preceded by an ownership re-check and a live-position check, and
  followed by a bounded read-back, before success is ever reported.
- Dry-run / live guard: identical gating to entry-package execution (`ABI_DRY_RUN=false`,
  `ABI_LIVE_TRADING_ENABLED=true`, both Bybit credentials configured, non-mainnet `BYBIT_ENV`).
  Protection is never reported applied unless a live write actually happened and was verified.
