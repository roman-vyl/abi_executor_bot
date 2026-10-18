## Context

Evidence: Bybit demo read-only check of cycle `2beec9fd` (raw responses on the Mac, `BBB_data/archive/integration-2026-10-17/bybit-history-cycle-2beec9fd.json`). Existing attribution primitive: `resolveOwnAttachedProtection` (`native-partial-protection-attribution`), which already links children by `parentOrderLinkId === entry orderLinkId` and reads role from `stopOrderType`.

## Decisions

### D1. One completion proof, three reasons

A pure-query module `proveOwnCycleCompletion(record, ownExposure)` returns `proven(reason, ids)`, `not_proven`, or `contradictory`. Inputs are this cycle's own orders only; the aggregate position is never proof.

Preconditions for any proof: the record's own entry order is terminal (cannot add exposure) and its own cumulative filled quantity `Q` is positive.

- `runtime_signal`: `close_order_link_id` is set and its own close order is classified `matched` for `Q` (existing `classifyOwnCloseOrderOutcome`). Ids: `order_link_id = close_order_link_id`, `order_id` from that order's row, `parent_order_link_id = null`.
- `stop_loss` / `take_profit`: `resolveOwnAttachedProtection` returns `attributed`; exactly one leg has `orderStatus: "Filled"`, `leavesQty = 0`, `cumExecQty = Q`; the other leg is terminal without fill (`Deactivated`, `Cancelled`); the execution list for the filled leg's `orderId` sums `execQty` of `Trade` rows to exactly `Q`. Ids: `order_id` = leg `orderId`, `order_link_id = null` (a native child's own link id is empty), `parent_order_link_id` = entry `orderLinkId`.
- `contradictory`: both legs filled; any leg `PartiallyFilled` or filled with `cumExecQty ≠ Q`; a protection fill together with a matched or partially filled own close order; execution sum ≠ `Q`.
- `not_proven`: anything else, including history lag (`none`, `partial_pair`, missing executions).

Child `cumExecQty` is added to `BybitChildOrderCandidate` and `AttachedProtectionLeg`; a malformed value is a protocol failure of that page, as for other fields.

### D2. Durable completion

On `proven`, under the pair mutex, ABI writes `status: "terminal_closed"` and `closure_reason`, `closure_order_id`, `closure_order_link_id`, `closure_parent_order_link_id`, then releases the physical scope exactly as the existing terminal write does. A failed write yields `internal_error`. Records without these fields stay readable (same tolerance as `close_order_link_id`).

### D3. Open-position lookup

- Durably closed bucket: `terminal_closed` with stored closure fields returns that closure. `terminal_closed` without them, but with both `close_order_link_id` and `close_order_id`, returns `runtime_signal` from those. Any other durably closed record returns `closure: null` (no fill was established under this binding).
- Live bucket, own filled quantity `0`: `position_open: false`, `closure: null` (unchanged).
- Live bucket, filled: ABI also resolves own protection (`resolveOwnAttachedProtection`, two symbol-scoped reads).
  - An own protection leg shows any fill, or the aggregate query returns `no_position`: run D1. `proven` → D2, then `position_open: false` + closure. `not_proven` or `contradictory` → `internal_error`, no write. A same-side aggregate row (a sibling's) never hides a proven own exit, because the proof uses only this cycle's own orders.
  - Otherwise: unchanged (`position_open: true`, `closure: null`, existing side check).

### D4. Close

After the entry is neutralized and `Q` resolved, and before `neutralizeOwnProtection`, ABI runs D1:
- `proven` → D2, return `trade_cycle_closed` with the closure; no cancel, no close order.
- `contradictory`, or any own protection leg with a fill but `not_proven` → `internal_error`; no close order is ever dispatched in this state.
- otherwise → existing pipeline unchanged; its success returns `closure` with `runtime_signal`, or `null` when `Q = 0`.

`neutralizeOwnProtection` additionally refuses to treat a leg with any fill as clean terminal absence.

### D5. Contract

`closure` is a required key in both success objects, `null` or an object with exactly the six keys. `reason` ∈ {`stop_loss`, `take_profit`, `runtime_signal`}. `order_link_id` is non-null only for `runtime_signal`; `parent_order_link_id` is non-null only for the two protection reasons; `order_id` is always non-null. `closure` requires `position_open: false`.

## Risks

- Bybit history lag right after a fill: lookup returns `internal_error` and Runtime retries next bar. Accepted.
- Multi-fill protection legs are not proven on demo; they resolve through the execution sum or fail closed.
- The lookup gains two Bybit reads per open cycle per bar. Runtime's lookup timeout is 5 s and timed out 8 times overnight on 2026-10-17; a timeout only skips the bar.
- Rollout: Runtime must accept `closure` first.
