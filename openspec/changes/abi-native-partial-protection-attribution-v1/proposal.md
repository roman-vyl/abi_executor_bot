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

**A technical fact this proposal's design depends on is not yet independently confirmed against a real
Bybit response**: that Bybit's order-query endpoints expose a field naming a `tpslMode: "Partial"` child
order's parent order, and a field reliably distinguishing a stop-loss child from a take-profit child.
`docs/virtual-exposure-ownership-delivery-plan.md`'s §6 risk 4 (revised in revision v15) already flags
this and recommends a Demo-based technical spike before this proposal is written. This proposal is
written anyway, on the following basis: every requirement and primitive below is phrased around
*behavior* (attribution, classification, fail-closed ambiguity), not around a specific assumed field
name, and `tasks.md` §1 makes the spike the first, blocking task — nothing past it may be implemented
against an assumed shape. If the spike finds the mechanism does not work as hypothesized (no reliable
parent-attribution field, or no reliable leg-role field), that is this change's own kill/redesign
condition, evaluated before any other task proceeds, not a risk to discover mid-implementation.

## What Changes

- New read-only, query-driven primitive that answers "what are this cycle's own attached protection
  children right now": given a trade cycle's own entry `orderLinkId`, query Bybit's order state for the
  same `(category, symbol)` scope, filter to orders whose parent-attribution field matches that entry
  `orderLinkId`, and classify the result — never guessing between multiple plausible candidates.
- A new decode primitive for **list**-shaped order-query responses (potentially several rows for one
  `(category, symbol)` scope), distinct from the existing `decodeOrderQueryResponse`
  (`src/services/entryPackage/orderQueryResponseDecoder.ts:47-141`), which is hard-scoped to exactly one
  `orderLinkId` and rejects more than one returned row by design. Children are not looked up by their own
  `orderLinkId` (ABI never generates or knows it in advance — Bybit assigns it) — they are found by
  scanning a broader, symbol-scoped query and filtering client-side by parent-attribution.
- One new adapter primitive on `BybitAdapter`/`RestBybitAdapter` for a **symbol-scoped, not
  `orderLinkId`-scoped**, order-history query. `getActiveOrders` (`src/exchange/bybitAdapter.ts:148-158`)
  already queries `/v5/order/realtime` scoped by symbol alone and is directly reusable for **live**
  children; nothing in the codebase today queries `/v5/order/history` without a required `orderLinkId`
  (`BybitGetOrderHistoryPayload`, `src/exchange/bybitOrderMapper.ts:61-66`), so a **terminal** child
  (already filled, or already cancelled) is not currently discoverable at all. This gap is real and is
  this change's own problem to close — not deferred to a later change — because correct classification
  (Decisions below) requires seeing terminal children, not only live ones.
- Strict classification of whatever set of matching children is found for one entry `orderLinkId`:
  zero children is valid only while no fill is proven and/or mapping is not yet `"Partial"`; exactly one
  stop-role and one take-role child is the only healthy "attributed pair" outcome; anything else (extra
  or duplicate candidates, an unclassifiable child, zero children when fill+Partial is already proven)
  is `ambiguous` and fails closed — never resolved by picking "the most plausible" candidate.
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
- Blocking precondition: `tasks.md` §1's technical spike against Bybit (Demo) must confirm the
  parent-attribution and leg-role fields exist and behave as hypothesized before any decode/classification
  code in this proposal is implemented against them.
