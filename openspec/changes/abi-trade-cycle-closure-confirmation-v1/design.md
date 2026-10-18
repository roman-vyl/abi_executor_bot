## Context

Two independent mechanisms can end a filled cycle: Bybit's native protection (stop or take-profit child of the entry, `tpslMode: "Partial"`) and Runtime's Close command. They race. Today ABI proves only its own close order, so a protection exit makes the lookup fail forever, and Close can misread a filled protection leg.

Evidence: Bybit demo read-only check of cycle `2beec9fd` (raw responses on the Mac, `BBB_data/archive/integration-2026-10-17/bybit-history-cycle-2beec9fd.json`): entry `Filled` 0.001; stop child `Filled`, own `orderLinkId` empty, `parentOrderLinkId` = entry `orderLinkId`, stable `orderId`, `stopOrderType: "PartialStopLoss"`, `cumExecQty` 0.001, `leavesQty` 0, one `Trade` execution of 0.001; take child `Deactivated` in the same second.

Existing code reused (main `97a0222`): `CloseApplicationService.neutralizeEntry`, `resolveOwnExposure` (`confirmEntryPackage`), `resolveOwnAttachedProtection`, `neutralizeOwnProtection`, `classifyOwnCloseOrderOutcome`, `aggregateIsCompatible`, `closePositiveExposure`, `verifyTerminalPostconditions`, `persistTerminal`; `OpenPositionResolutionService` status buckets and own fill facts; the pair mutex.

## Principle

Completion of a cycle is proven only by full execution of an order ABI attributes to that exact pair (`strategy_instance_id`, `trade_cycle_id`). The aggregate position, its size change, receipt of a Close command, and an accepted cancel are never proof. V1 has three reasons: `stop_loss`, `take_profit`, `runtime_signal`. Anything ABI cannot prove is an error with no durable write.

## Decisions

### D1. Protection state classes

`Q` is the cycle's own cumulative entry fill (`confirmEntryPackage`), with the entry order terminal. Each `resolveOwnAttachedProtection` result maps to exactly one class (child `cumExecQty` is added to the decoder and to `AttachedProtectionLeg`):

| Result | Class |
|---|---|
| `attributed`, both legs `cumExecQty = 0`, at least one leg live (`New`, `Untriggered`, `Triggered`) | **active**: may be neutralized |
| `attributed`, both legs `cumExecQty = 0`, both terminal without fill (`Deactivated`, `Cancelled`, `Rejected`) | **neutralized** |
| `attributed`, one leg `Filled`, `leavesQty = 0`, `cumExecQty = Q`; other leg terminal without fill, `cumExecQty = 0`; `Trade` executions of the filled leg sum to `Q` | **completed** (`stop_loss` or `take_profit` by `stopOrderType`) |
| `attributed` with any other fill (a leg `PartiallyFilled`, filled ≠ `Q`, both legs with fills, executions ≠ `Q`, filled leg while the other is still live) | **partial or contradictory** |
| `none` with `Q = 0` | **neutralized** (nothing was attached) |
| `none` with `Q > 0`; `ambiguous` (`partial_pair`, `query_failed`, `inconsistent_duplicate`, `duplicate_role`, `extra_candidates`, `unclassified_role`) | **unknown** |

`none` and `partial_pair` are never proof of absence (history lag; symbol history read is limited to 50 rows). A cycle with no take-profit attaches one child and resolves `partial_pair`; Close already fails closed for it today and V1 does not change that.

### D2. Completion proof

`proveOwnCycleCompletion(record, Q)` returns `completed(closure)`, `not_completed`, or `contradictory`:
- `runtime_signal`: `close_order_link_id` is set and its own close order is classified `matched` for `Q`. `order_id` comes from that order's read-back row, `order_link_id = close_order_link_id`, `parent_order_link_id = null`.
- `stop_loss` / `take_profit`: the protection class is **completed**. `order_id` = filled leg `orderId`, `order_link_id = null`, `parent_order_link_id` = entry `orderLinkId`.
- `contradictory`: a protection fill of any size together with a matched or partially executed own close order; or the protection class is **partial or contradictory**.
- otherwise `not_completed`.

### D3. Durable completion and idempotency

On `completed`, under the pair mutex, ABI writes in one record save `status: "terminal_closed"` with `closure_reason`, `closure_order_id`, `closure_order_link_id`, `closure_parent_order_link_id`. Leaving the active statuses is what releases the physical scope (existing behaviour of `persistTerminal`), so the scope is released only after proof. The closure fields are written only together with `terminal_closed` and never change afterwards. A failed save yields `internal_error`.

The existing Runtime-close success path writes the same fields (`runtime_signal`) in its `persistTerminal`.

Answers for a `terminal_closed` record, with no exchange call, both for lookup and Close:
- stored closure fields → that closure;
- legacy record without them but with `close_order_link_id` and `close_order_id` → `runtime_signal` from those;
- otherwise → `closure: null` (closed with zero own exposure, or a legacy close whose order id was not read). Runtime has already removed such a cycle.

`absent` and `terminal_unfilled` answer `closure: null`.

### D4. Open-position lookup

- Durably closed bucket: D3.
- Live bucket, `Q = 0`: `position_open: false`, `closure: null` (unchanged).
- Live bucket, `Q > 0` (entry may still be live): protection is resolved on every lookup of a filled cycle (two symbol-scoped reads). ABI runs the proof when any of these holds: `close_order_link_id` is set (independent of the aggregate, so an executed own close is found while a sibling keeps the slot open); the aggregate query returns `no_position`; the protection class is **completed** or **partial or contradictory**.
  - `completed` → D3, then `position_open: false` with the closure.
  - `not_completed` or `contradictory` → `internal_error`, no write. The proof requires a terminal entry order; a live entry with a fill is `not_completed`.
- Otherwise (no own close order, a same-side aggregate row, protection **active**, **neutralized** or **unknown**): unchanged, `position_open: true`, `closure: null`. This keeps today's answer for an open position whose protection is missing or briefly invisible, so Runtime's protection management keeps working; Close stays safe because D5 refuses to dispatch on **unknown** protection.

### D5. Close sequence

Steps of `CloseApplicationService.process` in order; only steps 1–3 may run before the first proof, and none of them can change exposure:

1. Existing classification: unknown binding, `terminal_closed` (answer from D3), `absent`/`terminal_unfilled` (existing terminal write, `closure: null`), scope and side checks.
2. `neutralizeEntry`: cancel this cycle's own entry order if still live and confirm it terminal. This is the only cancel allowed before the proof; it removes a source of new exposure and never reduces any.
3. `resolveOwnExposure` → `Q`.
4. **First proof** (D2). `completed` → D3 and return `trade_cycle_closed` with the closure; no protection cancel, no close order. `contradictory` → `internal_error`.
5. Protection class (D1): **unknown** or **partial or contradictory** → `internal_error`. **neutralized** → step 7. **active** → step 6.
6. `neutralizeOwnProtection` cancels the live legs. An accepted cancel is not proof that the leg did not fill. After the cancels ABI re-resolves protection and requires class **neutralized**. Class **completed** here means the leg filled during neutralization: D3 and return that closure. Any other class, including `none` after a cancel, → `internal_error`. This replaces today's acceptance of `none` after an accepted cancel and today's treatment of a `Filled` leg as terminal absence.
7. `close_order_link_id` already set (re-drive) → existing outcome check of that order; otherwise `aggregateIsCompatible` and the existing dispatch of one reduce-only market order for exactly `Q`.
8. Existing execution check of the own close order (`matched` for `Q`, or `close_execution_incomplete`).
9. `verifyTerminalPostconditions` with protection required in class **neutralized** (not merely terminal), then D3 with `runtime_signal`.

A market close order is never dispatched when any of these holds: the first proof is `completed` or `contradictory`; protection is **unknown**, **partial or contradictory**, or **completed**; protection after neutralization is anything but **neutralized**; any own protection leg shows `cumExecQty > 0`; the own entry is not proven terminal; `Q` is not resolved; the record is durably closed; or a previously dispatched own close order's fate is unconfirmed (existing rule).

### D6. Contract

`closure` is a required key in both success objects after ABI ships: `null`, or an object with exactly `strategy_instance_id`, `trade_cycle_id` (equal to the path), `reason`, `order_id`, `order_link_id`, `parent_order_link_id`. `reason` ∈ {`stop_loss`, `take_profit`, `runtime_signal`}; `order_id` always non-null; `order_link_id` non-null only for `runtime_signal`; `parent_order_link_id` non-null only for protection reasons. A lookup with a closure has `position_open: false` and null fill facts. Execution price and time are not in V1. Rollout: Runtime first (accepts the key or its absence), then ABI.

## Multiple strategies on one slot

What ABI guarantees:
- Every proof step reads only orders attributed to the pair: protection by `parentOrderLinkId`, close by the pair's own `close_order_link_id`, fills by the pair's own entry. A sibling's position does not keep this cycle open (D4).
- After a proven execution of the cycle's own protection, or of its own close order, ABI sends no further close order (D3, D5).
- Before a market close ABI uses the existing physical position check `aggregateIsCompatible`.

Limit: `aggregateIsCompatible` checks only that the position has the expected side and `position_size >= Q`. It does not reconcile the position against the total exposure of all owners in the slot. If the physical position changes in a way ABI cannot attribute to any cycle's own orders (manual action, liquidation, auto-deleveraging), a market close for `Q` can still reduce another cycle's exposure. Bybit V5 has no per-order position, so V1 accepts this risk. V1 adds no sum reconciliation, no remaining-exposure model and no slot mutex.

## Out of V1

Closing a remainder after a partial protection fill, manual closes, liquidation, websocket monitoring, entry-cycle recovery for a protection exit, execution price and time.

## Risks

- History lag → `internal_error`; Runtime retries on the next bar or the next recovery attempt. Once proven, the stored closure removes further exchange reads.
- Accepted V1 limit: `resolveOwnAttachedProtection` reads one page of the symbol's order history, limit 50. If the cycle's own protection orders fall out of that page, completion cannot be proven and the cycle stays blocked (lookup and Close return `internal_error`). V1 does not add pagination or change the history adapter.
- The lookup gains two Bybit reads per filled cycle per bar against Runtime's 5 s timeout (8 timeouts overnight on 2026-10-17); a timeout only skips the bar.
