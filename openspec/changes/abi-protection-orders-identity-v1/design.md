## Context

Facts from ABI main `b7ed3b8`:

- **Proof already reads both orders.** `reconcileNativePartialProtection` (`nativeProtectionReconciliation.ts:125-212`) calls `resolveOwnAttachedProtection` and gets `{kind: "attributed", stop, take}`, each an `AttachedProtectionLeg` with `orderId`, `orderStatus`, `triggerPrice`, `qty`, `leavesQty`, `cumExecQty` (`nativeProtectionAttribution.ts:15-24, 240-250`).
  - `already_satisfied`: the initial read matches the desired state and no leg is terminal.
  - `reconciled`: after the amend calls, a fresh read-back is attributed, matches and has no terminal leg.
  - Both outcomes drop the legs: they return only `{kind}`.
- **Response.** `serializeProtectionApplied` (`positionManagementApi.ts:255-286`) returns the five-key body, echoing the accepted `stop_price`/`take_price`.
- **Attribution.** Native children are attributed only by `parentOrderLinkId`; their own `orderLinkId` is empty (`nativeProtectionAttribution.ts:55-60`).
- **Surrogate take.** A `null` take is a dormant surrogate take order, always present (`protection-execution` "A disabled take is represented as a deterministic dormant surrogate").

## Decisions

### D1. One required key, closed shapes

`protection_orders` is required in every protection success body. It is a closed object with exactly `quantity`, `stop` and `take`:

- `quantity`: positive exact decimal string, the position quantity the protection covers: the cycle's current own filled quantity, which both legs carry as Bybit `qty` (success already requires both legs' `qty` to equal it); taken from the stop leg's `qty`;
- `stop`, `take`: closed objects with exactly `order_id` (non-empty string, Bybit `orderId`) and `trigger_price` (positive exact decimal string, Bybit `triggerPrice`).

The whole body stays a closed object of six keys.

### D2. Values come from the read that proved success

| Outcome | Source of both legs |
|---|---|
| `already_satisfied` | the initial `resolveOwnAttachedProtection` result that matched |
| `reconciled` | the post-amend read-back that matched |

The two success outcomes carry those legs: `{kind: "already_satisfied" | "reconciled"; stop: AttachedProtectionLeg; take: AttachedProtectionLeg}`. `ProtectionConfirmation` gains the two legs and `serializeProtectionApplied` writes them. No other source (write plan, request, earlier read) is used.

### D3. Bybit strings unchanged

`order_id`, `trigger_price` and `quantity` are Bybit's own strings, not reformatted (trailing zeros kept). Only `orderStatus`, `leavesQty`, `cumExecQty` are not exposed. If a proving leg has an empty `orderId`, a non-positive / non-decimal `triggerPrice` or `qty`, or the two legs' `qty` differ, `serializeProtectionApplied` returns `internal_error`, as it already does for any malformed success input.

### D4. Unchanged

- `stop_price`/`take_price` echo the accepted request strings (existing requirement).
- Success conditions, the write plan, surrogate take, read-back, live-execution guard, terminal-leg rule, error vocabulary.
- Bybit request count per protection call.
- Correlation record and readiness; nothing is persisted.
- Close endpoint.

## Risks / Trade-offs

- **Runtime strict codecs.** A Runtime that does not know the key rejects every protection success, so position management stops moving stops until both are deployed. Rollout: Runtime merges first, both deploy together, both roll back together.
- **Surrogate take visible.** For `take_price: null`, the body shows a real far take order. Readers must not treat it as a requested take; `take_price: null` stays the request fact.
- **Quantity is the position quantity at proof time** (the cycle's current own filled quantity); a later partial fill changes it on a later call.
