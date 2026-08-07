## Why

Runtime already computes `ApplyProtection` (Engine recalculated management stop/take for an
already-open position) and already calls ABI's `PUT
/v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/protection`. That route
exists but ends in a stub: any transport-valid request unconditionally returns `internal_error`
(`positionManagementRoutes.ts`'s `handleProtection`) without resolving a scope, querying Bybit, or
writing anything. Runtime can never converge `latest_confirmed_management_protection` because ABI
never returns anything but a fabricated failure.

`abi-position-scope-exclusivity-v1` closed the precondition this needed: ABI now guarantees at most
one `(strategy_instance_id, trade_cycle_id)` pair owns a given physical scope (`category` + `symbol`)
at a time, derived durably from the existing correlation store. Protection execution can now safely
translate "apply protection for A/A1" into "write to Bybit's BTCUSDT position" — first proving BTCUSDT
is A/A1's own scope, not merely that A/A1 once had a BTC binding.

## What Changes

- Wire `PUT .../protection` to a new `ProtectionApplicationService` that, for a validated command:
  1. looks up the pair's `EntryPackageExecutionRecord` (`unknown_trade_cycle_binding` if none);
  2. re-verifies — independently of `position-scope-exclusivity`'s own bookkeeping, not merely by
     trusting it — that the record's own `(exchange_category, exchange_symbol)` is the scope this
     pair currently owns (`internal_error` on any mismatch, which should be unreachable under the
     invariant but must fail closed, not proceed, if it ever isn't);
  3. confirms Bybit currently reports a live position for that scope, reusing
     `open-position-resolution`'s existing validated live-query logic rather than re-deriving it
     (`position_not_open` when closed, `unsupported_exchange_scope` for non-`linear`, `internal_error`
     on any query failure);
  4. sends Bybit's position-level trading-stop write (`stopLoss`/`takeProfit`, `positionIdx=0`,
     `tpslMode=Full`), gated by the existing live-execution guard (`src/execution/liveGuard.ts`) —
     dry-run or live-trading-disabled fails closed with `internal_error`, exactly like entry-package
     execution today, never a fabricated `protection_applied`;
  5. re-queries the live position and confirms, by exact-decimal numeric comparison, that the
     confirmed stop/take equal the requested values before returning `protection_applied`
     (`ProtectionConfirmation` / `serializeProtectionApplied`, already defined in
     `positionManagementApi.ts` but never constructed by any caller today).
- Extend the shared validated position-query row (`ValidatedOpenPositionRow` /
  `queryPositionForInstrument`) with the position's own `stopLoss`/`takeProfit` fields so read-back
  reuses the same validated query path instead of a second, parallel one.
- Serialize protection commands against the same per-pair `KeyedMutex` instance entry-package apply
  already uses, keyed the same way, so a protection PUT can never race a concurrent
  create/replace/cancel for the same pair. No new lock is introduced; the existing scope-level
  `scopeMutex` is not touched (protection neither claims nor releases a scope).
- New capability spec `protection-execution` (parallel to `entry-package-execution` and
  `open-position-resolution`) documents these mechanics; the public contract in
  `abi-position-management-api` is unchanged — its requirements already fully described this
  behavior, only the stub kept them from being true.

Non-goals (unchanged from prior roadmap statements, restated here): `DELETE .../open-position` stays
a transport-only stub; releasing a physical scope after a fill (needed once a trade cycle actually
closes) stays deferred to a future close-execution change; no shared/virtual scope ownership; no
command IDs or a new retry/idempotency architecture beyond re-applying the requested values on
repeat; no new durable field on `EntryPackageExecutionRecord` — ABI's correlation record continues to
track only order identity, not the currently-applied protection, since Runtime is the owner of
`latest_confirmed_management_protection`.

## Capabilities

### New Capabilities
- `protection-execution`: how ABI executes an already-contracted `PUT .../protection` request —
  scope resolution and ownership re-verification, the live-position gate, the Bybit write, and the
  read-back verification that gates `protection_applied`.

### Modified Capabilities
None. `abi-position-management-api`'s requirements for the protection endpoint already specify this
behavior; `position-scope-exclusivity` and `open-position-resolution` are consumed as-is, unchanged.

## Impact

- Public HTTP contract: unchanged. Same route, same request/response DTOs, same error codes
  (`unknown_trade_cycle_binding`, `unsupported_exchange_scope`, `position_not_open`,
  `internal_error`). No new public error code.
- Correlation store: unchanged on-disk shape and unchanged write path — protection execution reads
  the existing record but does not write to the correlation store at all.
- Concurrency: reuses the existing per-pair `mutex`; no new lock, no change to
  `position-scope-exclusivity`'s scope-acquisition/release rules.
- Trading safety: closes the gap where a protection command was either silently rejected (current
  stub) or, if implemented naively, could act on Bybit without proving pair ownership of the
  physical scope first. Every write is preceded by an ownership re-check and a live-position check,
  and followed by a read-back before success is reported.
- Dry-run / live guard: identical gating to entry-package execution — `ABI_DRY_RUN=false`,
  `ABI_LIVE_TRADING_ENABLED=true`, both Bybit credentials configured, non-mainnet `BYBIT_ENV`.
  Protection is never reported applied unless a live write actually happened and was verified.
- Prerequisite relationship: this uses, but does not modify, `position-scope-exclusivity`'s
  ownership index and `open-position-resolution`'s live-query logic. It does not implement
  post-fill scope release; that remains for the close-execution change that will follow.
