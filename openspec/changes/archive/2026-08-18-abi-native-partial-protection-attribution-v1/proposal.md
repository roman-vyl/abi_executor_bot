## Why

`docs/virtual-exposure-ownership-delivery-plan.md` (revision v15) replaced this program's original
Changes 6–8 design. The original design had ABI itself create, own, and manage reduce-only conditional
stop/take orders per trade cycle — its own `orderLinkId` roles, its own `protection_generation`, its own
create/cancel lifecycle, its own OCO logic between the two legs. That design was analyzed in detail (a
dedicated design-check confirmed a shared `protection_generation` per tuple is sufficient, a 7-field
durable model closes every crash window, and deriving a prior generation's identity from `generation - 1`
is both safe and necessary) — and then set aside, not because it was wrong, but because it duplicates a
mechanism Bybit already provides natively: `mapEntryPackageToBybit()` already attaches position-level
protection to every entry order today via `tpslMode: "Full"`
(`src/exchange/bybitOrderMapper.ts:107-131`). The same parameter accepts `"Partial"`, under which Bybit
materializes its own child TP/SL orders **per parent order** rather than per physical position. If those
children carry their parent's identity in a queryable field, ABI does not need to invent a
protection-order lifecycle at all — it needs to **discover and attribute** what Bybit already creates.

This change is the first of three (`abi-native-partial-protection-attribution-v1` →
`abi-native-partial-protection-lifecycle-v1` → `abi-native-partial-protection-cutover-v1`) that replace
the old design. It is a read-only foundation: it does not create, cancel, or modify any order, and it
does not change what `PUT .../entry-package` sends to Bybit today (`tpslMode: "Full"` stays exactly as
it is). Its only job is to let ABI answer, truthfully and fail-closed on any ambiguity, "what protection
children, if any, has Bybit materialized for this cycle's own entry order" — the primitive both the
replacement lifecycle (`abi-native-partial-protection-lifecycle-v1`) and the eventual cutover
(`abi-native-partial-protection-cutover-v1`) are built on.

**The technical fact this proposal's design depends on has now been confirmed against real Bybit Demo
responses** (`docs/virtual-exposure-ownership-delivery-plan.md`'s §6 risk 4, revised in revision v15,
called for exactly this spike before this proposal was finalized). Confirmed: a `tpslMode: "Partial"`
child order carries `parentOrderLinkId`, equal to the parent entry's own `orderLinkId` — the sole
attribution key; a child's own `orderLinkId` is observed empty and is never used as identity;
`stopOrderType = "PartialTakeProfit"`/`"PartialStopLoss"` is the sole role discriminator, corroborated by
`createType`; live children are visible via the existing symbol-scoped realtime query, terminal children
via a symbol-scoped history query (subject to a propagation lag — an immediate empty history result is
not proof of absence); the same child appearing in both query sources must be deduplicated by `orderId`.
Full detail: `design.md` Decision 0. What the spike did **not** settle — multi-fill parent semantics
(whether a multi-fill parent always ends up with exactly one pair, whether children auto-resize, whether
Bybit ever creates additional pairs, whether materialization is atomic) — is left explicitly `NOT PROVEN`
and out of this change's scope; see `design.md`'s "What remains explicitly unproven" and Non-Goals. This
change's own classifier is safe under that gap: any shape beyond one attributed stop/take pair fails
closed rather than being silently accepted.

## What Changes

- New read-only, query-driven primitive that answers "what are this cycle's own attached protection
  children right now": given a trade cycle's own entry `orderLinkId`, query Bybit's order state for the
  same `(category, symbol)` scope, filter to orders whose confirmed `parentOrderLinkId` matches that
  entry `orderLinkId`, deduplicate by `orderId`, and classify the result — never guessing between
  multiple plausible candidates.
- A new decode primitive for **list**-shaped order-query responses (potentially several rows for one
  `(category, symbol)` scope), distinct from the existing `decodeOrderQueryResponse`
  (`src/services/entryPackage/orderQueryResponseDecoder.ts:47-141`), which is hard-scoped to exactly one
  `orderLinkId` and rejects more than one returned row by design. Children are not looked up by their own
  `orderLinkId` — confirmed observed as empty on every native child, never a usable identity — they are
  found by scanning a broader, symbol-scoped query and filtering client-side by `parentOrderLinkId`.
- One new adapter primitive on `BybitAdapter`/`RestBybitAdapter` for a **symbol-scoped, not
  `orderLinkId`-scoped**, order-history query. `getActiveOrders` (`src/exchange/bybitAdapter.ts:148-158`)
  already queries `/v5/order/realtime` scoped by symbol alone and is directly reusable for **live**
  children (confirmed by the spike); nothing in the codebase today queries `/v5/order/history` without a
  required `orderLinkId` (`BybitGetOrderHistoryPayload`, `src/exchange/bybitOrderMapper.ts:61-66`), so a
  **terminal** child (already filled, or already cancelled/deactivated) is not currently discoverable at
  all. This gap is real and is this change's own problem to close — not deferred to a later change —
  because correct classification (Decisions below) requires seeing terminal children, not only live ones.
  The history query has a confirmed propagation lag; the primitive reports what it finds rather than
  asserting absence.
- Strict classification of whatever deduplicated set of matching children is found for one entry
  `orderLinkId`: zero children is reported plainly, without ABI itself judging whether that is expected;
  exactly one stop-role and one take-role child, with no contradictory duplicate evidence, is the only
  healthy "attributed pair" outcome; anything else (extra or duplicate-role candidates, an unclassifiable
  child, only one role present, or the same `orderId` reported inconsistently across sources) is
  `ambiguous` and fails closed — never resolved by picking "the most plausible" candidate.
- A `tpslMode: "Partial"` payload prepared and unit-tested in `src/exchange/bybitOrderMapper.ts`, but
  **not** wired into `mapEntryPackageToBybit()`'s production path. Entry create keeps sending
  `tpslMode: "Full"` until `abi-native-partial-protection-cutover-v1`.

## Capabilities

### New Capabilities

- `native-partial-protection-attribution`: defines how ABI discovers and classifies its own entry
  order's Bybit-native attached protection children, the fail-closed rules for every non-clean outcome,
  and what this capability explicitly does not yet do (create, cancel, replace, or serve
  `PUT .../protection` from any of this).

### Modified Capabilities

None. `entry-package-execution`'s order-create/cancel/confirm semantics and wire mapping are unchanged;
`protection-execution`'s `PUT .../protection` production behavior (still `setTradingStop`/
`tpslMode: "Full"`, still the `abi-same-side-virtual-exposure-ownership-v1` guard for multi-owner scope)
is unchanged; `position-scope-exclusivity` is unaffected.

## Impact

- Public HTTP contract: unchanged. No new route, DTO field, or public error code.
- Production behavior: unchanged. `mapEntryPackageToBybit()` still emits `tpslMode: "Full"`;
  `ProtectionApplicationService`, `CloseApplicationService`, `EntryPackageApplicationService`'s claim
  policy, and `EntryPackageCorrelationRepository` are not modified by this change.
- Correlation store on-disk shape: unchanged. No new field on `EntryPackageExecutionRecord`.
- New Bybit read traffic: one additional query shape (`/v5/order/history`, symbol-scoped) that does not
  exist in this codebase today; used only by this change's own new primitive, never by any production
  call path.
- Prerequisite relationship: this is the foundation `abi-native-partial-protection-lifecycle-v1` (the
  replacement/update lifecycle for a cycle's stop/take pair) and, eventually,
  `abi-native-partial-protection-cutover-v1` (the mapping cutover and Change 5 guard removal) are built
  on. Neither of those is implemented, wired, or activated by this change.
- Note for `abi-native-partial-protection-lifecycle-v1`, not this change: multi-fill parent semantics are
  explicitly `NOT PROVEN` (`design.md`, "What remains explicitly unproven") — unproven exchange behavior
  that change must not assume in either direction, not a precondition it needs proven first (two Demo
  smoke attempts already showed multi-fill is impractical to reliably demonstrate there; `design.md`
  records the more robust reconciliation-based requirement that change should adopt instead). This
  change's own scope (single attributed pair, fail closed otherwise) does not depend on it either way.
