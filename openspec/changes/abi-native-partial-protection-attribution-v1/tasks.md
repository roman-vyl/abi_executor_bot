## 1. Technical spike (blocking — no other task starts before this one closes)

- [ ] 1.1 Against Bybit Demo (not documentation alone): place a real entry order with `tpslMode:
      "Partial"`, `stopLoss`, `takeProfit` set, let it fill (or fill it manually on Demo), then query
      `/v5/order/realtime` and `/v5/order/history` scoped by `symbol` only (no `orderLinkId`). Capture the
      raw response rows for the two materialized children.
- [ ] 1.2 Confirm or refute: a field on each child row names its parent order, matching the parent's own
      `orderLinkId` — design.md Decision 0's working hypothesis is `parentOrderLinkId`. Record the actual
      field name and its exact value shape.
- [ ] 1.3 Confirm or refute: a field on each child row reliably distinguishes the stop-loss leg from the
      take-profit leg — design.md Decision 0's working hypothesis is `stopOrderType` with distinct
      per-role values. Record the actual field name and the exact values observed for each role.
- [ ] 1.4 Observe and record what happens to the sibling leg when one leg fills (does it disappear from
      both realtime and history, or remain as a terminal — cancelled — row in history). This does not
      change this change's own classification (design.md Decision 3 treats both as legitimate `attributed`
      outcomes), but must be recorded for `abi-native-partial-protection-lifecycle-v1`'s design.
- [ ] 1.5 If 1.2 or 1.3 cannot be confirmed (no reliable parent-attribution field, or no reliable
      role-distinguishing field): STOP. Do not proceed to task 2 onward. Report back for a
      `docs/virtual-exposure-ownership-delivery-plan.md` architecture-review pass before any further
      implementation. This is the one condition under which this change's premise itself is wrong, not
      just its detail.
- [ ] 1.6 If confirmed: update design.md Decision 0/1/2/3 with the real field names in place of the
      working hypothesis before writing task 2 onward's code, so implementation and design never
      disagree.

## 2. Decode layer

- [ ] 2.1 In `src/services/entryPackage/orderQueryResponseDecoder.ts`, add `BybitChildOrderCandidate`
      type and `decodeChildOrderListResponse()` (design.md Decision 2), reusing the existing private
      `readOptionalStringField`/`isPositiveOrEmptyExactDecimal`/`isNonNegativeOrEmptyExactDecimal`
      helpers already in this file. Field names in the decoded shape match whatever task 1.6 confirmed —
      not the placeholder names in design.md if the spike found different ones.
- [ ] 2.2 Validates `category`/`symbol` match per row (same fail-closed discipline as
      `decodeOrderQueryResponse`) but accepts zero or many rows — does not reject on row count or on any
      particular `orderLinkId`.

## 3. Adapter primitive

- [ ] 3.1 Add `BybitGetOrderHistoryForSymbolPayload` to `src/exchange/bybitOrderMapper.ts` and
      `getOrderHistoryForSymbol()` to the `BybitAdapter` interface, `RestBybitAdapter`
      (`signedGet("/v5/order/history", ...)`, symbol-scoped, no `orderLinkId` — design.md Decision 4),
      and `StubBybitAdapter` (`bybitAdapter.ts`). Do not modify `getOrderHistory`,
      `BybitGetOrderHistoryPayload`, or any existing caller.

## 4. Attribution primitive

- [ ] 4.1 New file `src/services/protection/nativeProtectionAttribution.ts`: `AttachedProtectionLeg`,
      `AttachedProtectionResolution`, `resolveOwnAttachedProtection()` (design.md Decision 1) — queries
      `getActiveOrders({ symbol })` (existing, unmodified) and `getOrderHistoryForSymbol()` (task 3.1),
      decodes both via `decodeChildOrderListResponse()` (task 2.1), concatenates, filters by
      parent-attribution, classifies per design.md Decision 3.
- [ ] 4.2 No caching, no durable read or write, no internal bounded-retry loop (design.md Decision 1) —
      one fresh pair of queries per call, caller owns any retry cadence.

## 5. Mapper preparation (unwired)

- [ ] 5.1 Widen `BybitCreateOrderPayload.tpslMode` in `src/exchange/bybitOrderMapper.ts` from the literal
      `"Full"` to `"Full" | "Partial"`.
- [ ] 5.2 Add a new, separate payload-construction function (not a modification of
      `mapEntryPackageToBybit()`) producing the `tpslMode: "Partial"` shape — design.md Decision 6.
      `mapEntryPackageToBybit()`'s own return value and behavior are byte-for-byte unchanged; nothing in
      `EntryPackageApplicationService` calls the new function.

## 6. Spec delta

- [ ] 6.1 New capability `native-partial-protection-attribution`
      (`specs/native-partial-protection-attribution/spec.md`) — ADDED requirements for attribution
      correctness, fail-closed classification, no new durable state, and no production behavior change,
      phrased around behavior/invariants rather than the specific field names task 1.6 confirms (so the
      spec does not need editing if the spike's exact field names differ from design.md's placeholders).

## 7. Tests (all synthetic/fixture-driven — no real Bybit call in the test suite)

- [ ] 7.1 `decodeChildOrderListResponse`: zero rows → `{ kind: "ok", items: [] }`; several well-formed
      rows → all decoded; a malformed envelope/item → `protocol_failure`, same fail-closed discipline as
      the existing single-order decoder's own tests.
- [ ] 7.2 `resolveOwnAttachedProtection`: no matching candidates (parent-attribution field present on
      other orders, absent/mismatched for this entry) → `{ kind: "none" }`.
- [ ] 7.3 `resolveOwnAttachedProtection`: exactly one stop-role and one take-role candidate, both live →
      `{ kind: "attributed", stop, take }`.
- [ ] 7.4 `resolveOwnAttachedProtection`: exactly one stop-role and one take-role candidate, one found
      only in the history query (terminal) and one only in the realtime query (live) → still
      `{ kind: "attributed", ... }` — proves both query sources are actually merged, not just one.
- [ ] 7.5 `resolveOwnAttachedProtection`: only a stop-role candidate found, no take-role candidate (and
      the reverse) → `{ kind: "ambiguous", reason: "partial_pair" }`.
- [ ] 7.6 `resolveOwnAttachedProtection`: two candidates both classified as the same role →
      `{ kind: "ambiguous", reason: "duplicate_role" }`.
- [ ] 7.7 `resolveOwnAttachedProtection`: a candidate whose role field does not map to either role →
      `{ kind: "ambiguous", reason: "unclassified_role" }`.
- [ ] 7.8 `resolveOwnAttachedProtection`: attribution correctly excludes a same-`(category,symbol)`
      sibling's own children (synthetic multi-owner fixture, two different entry `orderLinkId`s, each
      with its own stop/take candidates present in the same symbol-scoped query result) — each own-call
      returns only its own pair, never the sibling's.
- [ ] 7.9 `getOrderHistoryForSymbol`/`getActiveOrders` payload-shape tests against fixtures — confirms the
      request omits `orderLinkId` and is scoped by `category`/`symbol` alone.
- [ ] 7.10 `tpslMode: "Partial"` payload-construction function: payload-shape test against a fixture,
      isolated from `mapEntryPackageToBybit()`'s own tests.
- [ ] 7.11 Full regression: `entryPackageApplicationService.test.ts`, `protectionApplicationService.test.ts`,
      `bybitOrderMapper`-related tests, and any existing `orderQueryResponseDecoder`/`packageConfirmation`
      tests all pass unmodified — none of them call the new primitives, and `mapEntryPackageToBybit()`'s
      own output is unchanged.

## 8. Final verification

- [ ] 8.1 `npm run typecheck`, `npm test`, `npm run build` all clean.
- [ ] 8.2 Diff review confirms: zero fields added to `EntryPackageExecutionRecord`;
      `EntryPackageCorrelationRepository`, `ProtectionApplicationService`, `CloseApplicationService`,
      `EntryPackageApplicationService`'s claim logic, and `mapEntryPackageToBybit()`'s existing return
      value are byte-for-byte unmodified; `getOrderHistory`/`BybitGetOrderHistoryPayload` and every
      existing caller of `decodeOrderQueryResponse` are untouched; no public HTTP route, DTO, or error
      code changed.
