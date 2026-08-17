## Why

`docs/virtual-exposure-ownership-delivery-plan.md` (the multi-change program tracking GitHub Issue #3)
names this change, Change 2, as the first consumer to build on the foundation
`abi-virtual-exposure-state-foundation-v1` shipped: close currently closes ABI's entire live Bybit
position for a pair's scope (`CloseApplicationService`, `closeApplicationService.ts:153-179`), trusting
only the live exchange query and never any ABI-recorded quantity (`close-execution` spec, "Closing acts
on the exact live remainder"). That is correct only while a physical scope can have at most one owner.
Once same-side ownership activation (a later change in the program) lets more than one trade cycle share
a physical scope, closing "the whole live position" for one cycle would also close its sibling's
exposure — a genuine, immediate correctness bug, not a hypothetical one.

The program's own sequencing insight is to prepare close for multi-owner *before* activation makes
multi-owner real in production, so the dangerous window between "scope can be shared" and "close knows
how to share it" never opens. This change does exactly that: close becomes a fraction-based trade-cycle
command (`exposure_fraction`), sourcing the requested cycle's own quantity from its own entry order's
fill facts (the `virtual-exposure-state` capability's `cumulative_filled_qty`/`isFillFactFinal`) rather
than the exchange's aggregate position, whenever more than one owner is actually present. Today, and
until same-side ownership activation ships, a scope can only ever have one owner
(`EntryPackageApplicationService`'s claim policy is untouched by this change), so this change's new code
path is exercised in production by exactly the same single-owner case as before, and by synthetically
seeded multi-owner fixtures otherwise — the same "prove it on fixtures, activate later" strategy Change 1
used for the correlation repository.

This also changes the public HTTP contract: `DELETE /v1/.../open-position` (an empty-bodied physical
close) is retired in favor of `POST /v1/.../close` with `{"exposure_fraction": "1"}` (a relative-intent
trade-cycle command). This is deliberate, not incidental — the whole point of the quantity-ownership
boundary Change 1 stated is that Runtime expresses relative intent and never learns or supplies an
absolute exchange quantity; an empty-bodied `DELETE` can't express "which cycle's fraction," and widening
it in place would blur "this call closes the physical position" with "this call closes a trade cycle's
share of it." V1 accepts only the canonical value meaning "the whole cycle" — no partial-close execution
ships here; this change only reserves the contract axis for it.

Because Runtime today calls a bare `DELETE`, this is a **coordinated cross-repo change**: Runtime's
`ClosePositionCommand` and its ABI HTTP client must gain `exposure_fraction` before or atomically with
this change's rollout. This proposal does not modify Runtime; the coordinated Runtime-side OpenSpec
change is tracked separately, outside this repository.

## What Changes

- **Public HTTP contract (breaking).** `DELETE /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position`
  is retired. It is replaced by `POST /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/close`
  with a required JSON body `{"exposure_fraction": "1"}`. Any value not numerically equal to `1` — `"0.5"`,
  `"0"`, `"2"`, a negative value, malformed text, a missing field, or an unknown field — is rejected as
  `validation_failed` before any exchange call. `GET .../open-position` is unaffected. The success response
  shape (`{strategy_instance_id, trade_cycle_id, status: "trade_cycle_closed"}`) is unchanged.
- **`CloseApplicationService` becomes owner-count-aware.** When the requested pair's scope has exactly one
  active record (today's only production-reachable state), behavior is byte-for-byte unchanged: the live
  aggregate position size is what gets closed, exactly as today. When it has more than one (synthetic
  fixtures only, until same-side ownership activation), ABI instead resolves the requested cycle's own
  exposure from a fresh, read-only re-query of its own entry order (reusing `confirmEntryPackage`, the same
  confirmation machinery entry-package execution already uses) and closes exactly that quantity — never a
  sibling's, never the raw aggregate.
- **A resolved exposure that materially exceeds the live aggregate fails closed** with a new dedicated
  error code, `position_exposure_drift`, rather than the generic `internal_error` — this is a detectable
  operational condition, not corruption. A small configurable non-negative tolerance (`AbiConfig`, default
  `"0"`) absorbs exchange-side rounding; within it, the sent quantity clamps down to what actually exists.
- **The postcondition close verifies before durably terminalizing generalizes** from "the live position is
  zero" to "the requested cycle's resolved exposure has been removed from the scope's aggregate" (zero, or
  decreased by exactly the closed quantity) — the same check, generalized; the single-owner case reduces to
  exactly today's zero-check and is verified through an unmodified, separate code path so today's behavior
  is provably untouched, not merely "equivalent under new math."
- **This pipeline never durably rewrites the requested cycle's recorded fill facts.** The fresh re-query
  used to resolve a multi-owner cycle's exposure is read-only for the purposes of this pipeline: its result
  is used in memory for this request only, never written back to `early_execution_observation`. Close
  remains, as before, a pipeline that reads fill facts but is not one of `virtual-exposure-state`'s existing
  observation-writing points.
- **Correlation repository is untouched.** `findActiveRecordsForScope` (delivered by Change 1) already
  derives its answer entirely from record status, so releasing this cycle's slot in the "active owners of
  this scope" set is already exactly what durably writing `status: "terminal_closed"` does today — no new
  repository method, and no change to `byScope`/`findOwnerByScope`/`applyScopeClaimOnWrite`/
  `rebuildScopeIndexFromReplay`, is needed by this change.

## Capabilities

### Modified Capabilities

- `close-execution`: close becomes a `POST .../close` fraction-based command. Single-owner execution and
  its postconditions are unchanged. A new multi-owner path (reachable today only via synthetic fixtures)
  resolves and closes the requested cycle's own exposure, verified never to close more than exists, and
  never to touch a sibling cycle sharing the same physical scope.
- `abi-position-management-api`: the close endpoint's method, route, and request body change from an
  empty-bodied `DELETE .../open-position` to a `POST .../close` command carrying `exposure_fraction`. A new
  business error code, `position_exposure_drift`, is added to the shared error vocabulary for close only.
  `malformed_json`/`unsupported_media_type` now apply to both endpoints (close now parses a JSON body).
  `PUT .../protection` and `GET .../open-position` are unaffected.

## Impact

- `src/services/close/closeApplicationService.ts`: owner-count branching, multi-owner quantity resolution
  and drift check, generalized postcondition verification (additive alongside the untouched single-owner
  path).
- `src/domain/positionManagementApi.ts`: `CloseCommand` gains `exposureFraction`; `validateCloseCommand`
  gains body validation; a new `position_exposure_drift` result helper and error code.
- `src/routes/positionManagementRoutes.ts`: `matchCloseRoute` moves from `DELETE .../open-position` to
  `POST .../close`; `handleClose` moves from the raw-empty-body check to the same JSON content-type/parse
  flow `handleProtection` already uses; the now-dead raw-body reader is removed.
- `src/config/config.ts`: new `positionExposureDriftToleranceQty` field, default `"0"`.
- `docs/openapi/abi-position-management-api-v1.json`: the close operation is replaced (method, path,
  request schema, business-error `oneOf`).
- Correlation store on-disk shape: unchanged. `virtual-exposure-state` capability: unchanged (no new
  observation-writing point is introduced).
- Runtime / MDS: Runtime's `ClosePositionCommand` and ABI HTTP client must be updated to send
  `exposure_fraction` — tracked as a separate, coordinated OpenSpec change outside this repository. This
  proposal does not implement or depend on completion of that change to be reviewed and merged, but
  **does** require it before production rollout (see design.md's rollout note).
- Production behavior: unchanged for every pair, since same-side ownership activation (which alone lets a
  production scope have more than one owner) has not shipped yet.
