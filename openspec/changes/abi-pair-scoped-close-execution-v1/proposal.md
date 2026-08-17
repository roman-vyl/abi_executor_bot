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

### Correction: the first draft's multi-owner safety model was unsafe

This proposal's first draft (baseline commit `f52796d`) resolved the requested cycle's multi-owner close
quantity from its own entry-order fill facts, then proved success by comparing the live aggregate
position before and after against that resolved quantity. Review found this unsafe: aggregate delta
reflects *every* owner's concurrent activity, not this request's own effect, so it cannot prove which
close command produced it once more than one cycle can move the same aggregate. A crash between a close
order executing and ABI durably recording that fact, followed by a retry, could resubmit a close order
sized from the (unchanged, since immutable-once-final) entry facts and consume a sibling's exposure — the
aggregate alone gave ABI no way to tell "my close already happened" from "my close never happened."

This revision replaces that model with an attributable close-order identity, mirroring the pattern
`EntryPackageApplicationService`'s own create/cancel pipeline already uses for the same reason: a
deterministic client order identity, written durably before the exchange call, whose own fate is checked
before ABI is ever allowed to send a second command under the same intent. See `design.md`'s Context and
Decisions 1-7 for the full analysis and the corrected design. Single-owner behavior — today's only
production-reachable path — is untouched by this correction.

## What Changes

- **Public HTTP contract (breaking) — unchanged from the first draft.** `DELETE /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position`
  is retired, replaced by `POST /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/close`
  with a required JSON body `{"exposure_fraction": "1"}`. Any value not numerically equal to `1` is
  rejected as `validation_failed` before any exchange call. `GET .../open-position` is unaffected. The
  success response shape (`{strategy_instance_id, trade_cycle_id, status: "trade_cycle_closed"}`) is
  unchanged.
- **Single-owner path — unchanged, still untouched.** Exactly one active record for the scope: byte-for-
  byte the same code as today, no new field read or written, no new Bybit call.
- **Multi-owner path now dispatches its close order under a stable, attributable identity** —
  `buildEntryPackageOrderLinkId(strategyInstanceId, tradeCycleId, "close", record.generation)`, widening
  `EntryPackageOrderRole` from `"entry"` to `"entry" | "close"` — durably recorded (`close_order_link_id`,
  `close_order_id`, two new nullable fields on `EntryPackageExecutionRecord`) **before** the exchange call,
  exactly mirroring how entry-package's own `createOrder()` already durably writes its provisional record
  before dispatching.
- **On retry or restart, ABI resolves the previously dispatched close order's own fate before ever sending
  another one** — reusing `confirmEntryPackage`/`classifyEntryOrderTerminality`, the same generic,
  already-existing confirmation primitives entry-package uses, keyed by the close order's own identity. A
  second close order is sent under the same identity only when a fresh query proves the first one was
  genuinely never created (`not_found`) — the one case already proven safe by
  `shouldResendPendingAction`'s identical precedent for entry.
- **The requested cycle's own close order is the exclusive proof of success**, not the aggregate: success
  requires that order's own confirmed executed quantity to exactly equal the quantity ABI resolved and
  submitted. The aggregate is read once, pre-dispatch, only to determine side and to sanity-check
  existence — it is not re-read for, and does not gate, success.
- **`position_exposure_drift` and its global `AbiConfig.positionExposureDriftToleranceQty` tolerance are
  removed entirely**, not merely renamed. The redesign eliminates the class of comparison (two
  independently-derived quantities) that tolerance existed to absorb: both sides of the new gate originate
  from the same request (the quantity ABI submitted vs. that same order's own confirmed execution), so
  there is no independent-rounding gap left to tolerate. A new code, `close_execution_incomplete` (422,
  close-only), covers both partial execution and outright zero-execution rejection.
- **A close order that definitively executes for less than requested, or is rejected/cancelled with zero
  execution, fails closed permanently for that generation in V1** — no automatic resubmission under a
  fresh identity, since reusing an already-used `orderLinkId` is unsafe and a generation-scoped
  close-identity bump is deliberately not introduced here. This is an explicit, accepted V1 limitation
  (see `design.md` Risks), not an oversight.
- **Correlation repository indexing/replay/`byScope` remains untouched** — the minimum durable state this
  correction requires is two flat, nullable fields on the existing record and one validator clause, not a
  new store, index, or repository method.

## Capabilities

### Modified Capabilities

- `close-execution`: close becomes a `POST .../close` fraction-based command. Single-owner execution and
  its postconditions are unchanged. The multi-owner path (reachable today only via synthetic fixtures)
  dispatches its close order under a durable, attributable identity, never sends a second one while the
  first's fate is unconfirmed, and gates success on that order's own confirmed execution rather than an
  aggregate-position comparison.
- `abi-position-management-api`: the close endpoint's method, route, and request body change from an
  empty-bodied `DELETE .../open-position` to a `POST .../close` command carrying `exposure_fraction`. A
  new business error code, `close_execution_incomplete`, is added to the shared error vocabulary for close
  only. `malformed_json`/`unsupported_media_type` now apply to both endpoints (close now parses a JSON
  body). `PUT .../protection` and `GET .../open-position` are unaffected.

## Impact

- `src/domain/entryPackageOrderIdentity.ts`: `EntryPackageOrderRole` widens to `"entry" | "close"`.
- `src/correlation/entryPackageExecutionRecord.ts`: two new nullable fields (`close_order_link_id`,
  `close_order_id`); `isValidEntryPackageExecutionRecord` updated to tolerate their absence on
  pre-existing durable rows; `createOrder()`'s provisional-record literal (entry-package, unrelated
  service) gains explicit `null` initialization for both so a new generation never inherits a stale value.
- `src/exchange/bybitOrderMapper.ts`: `BybitMarketCloseOrderPayload` gains an optional `orderLinkId?:
  string`, set only by the multi-owner branch.
- `src/services/close/closeApplicationService.ts`: owner-count branching (unchanged from the first draft),
  multi-owner close-identity dispatch/retry-resolution, and a generalized postcondition gated on the close
  order's own confirmed execution (additive alongside the untouched single-owner path).
- `src/domain/positionManagementApi.ts`: `CloseCommand` gains `exposureFraction`; `validateCloseCommand`
  gains body validation; a new `close_execution_incomplete` result helper and error code (replacing the
  first draft's `position_exposure_drift`).
- `src/routes/positionManagementRoutes.ts`: `matchCloseRoute` moves from `DELETE .../open-position` to
  `POST .../close`; `handleClose` moves from the raw-empty-body check to the same JSON content-type/parse
  flow `handleProtection` already uses; the now-dead raw-body reader is removed.
- `src/config/config.ts`: **no change** — the first draft's `positionExposureDriftToleranceQty` field is
  dropped from this proposal entirely, not added.
- `docs/openapi/abi-position-management-api-v1.json`: the close operation is replaced (method, path,
  request schema, business-error `oneOf` — `CloseExecutionIncompleteError` instead of
  `PositionExposureDriftError`).
- `docs/virtual-exposure-ownership-delivery-plan.md`: Change 2's section is minimally corrected to
  describe the attributable-close-identity model in place of the aggregate-delta model; no other change in
  the program is touched.
- Correlation store on-disk shape: additive only (two new nullable fields on one existing record type).
  `virtual-exposure-state` capability: unchanged (no new observation-writing point is introduced; the two
  new fields belong to `close-execution`, not to that capability's fill-fact contract).
- Runtime / MDS: Runtime's `ClosePositionCommand` and ABI HTTP client must be updated to send
  `exposure_fraction` — tracked as a separate, coordinated OpenSpec change outside this repository. This
  proposal does not implement or depend on completion of that change to be reviewed and merged, but
  **does** require it before production rollout (see `design.md`'s Migration Plan).
- Production behavior: unchanged for every pair, since same-side ownership activation (which alone lets a
  production scope have more than one owner) has not shipped yet.
