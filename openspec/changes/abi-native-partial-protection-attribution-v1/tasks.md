## 1. Technical spike (blocking — complete; confirmed facts recorded in design.md Decision 0)

- [x] 1.1 Against Bybit Demo (not documentation alone): placed a real entry order with `tpslMode:
      "Partial"`, `stopLoss`, `takeProfit` set, let it fill, then queried `/v5/order/realtime` and
      `/v5/order/history` scoped by `symbol` only (no `orderLinkId`). Captured the raw response rows for
      the materialized children.
- [x] 1.2 Confirmed: `parentOrderLinkId` on each child row names its parent order, matching the parent's
      own `orderLinkId`. A child's own `orderLinkId` is observed as an empty string — not an attribution
      identity. Recorded as design.md Decision 0, facts 1-2.
- [x] 1.3 Confirmed: `stopOrderType` reliably distinguishes the roles —
      `"PartialTakeProfit"` (take) / `"PartialStopLoss"` (stop). `createType` (`"CreateByPartialTakeProfit"`/
      `"CreateByPartialStopLoss"`) is present and consistent, recorded as secondary corroborating evidence
      only, not an independent discriminator. Recorded as design.md Decision 0, facts 3-4.
- [x] 1.4 Observed and recorded: active children are visible via the existing symbol-scoped realtime
      query; terminal children (a confirmed observed status: `"Deactivated"`, already classified
      terminal-without-fill by this codebase's existing `TERMINAL_WITHOUT_FILL_STATUSES`) are recoverable
      only via a symbol-scoped history query, which has a confirmed **propagation lag** — an immediate
      empty history result after a transition is not proof of absence. The same child can appear in both
      query sources during the transition window and must be deduplicated by `orderId`. A terminal
      record's `qty` persists at its original value; `leavesQty = 0` is the field that reflects
      consumption. Recorded as design.md Decision 0, facts 6-10, and design.md's "What remains explicitly
      unproven" (multi-fill parent semantics — atomicity of materialization, auto-resize, additional
      pairs — were **not** settled by this spike and are explicitly out of this change's scope).
- [x] 1.5 Not triggered — 1.2 and 1.3 both confirmed. This change's premise holds.
- [x] 1.6 design.md Decision 0/1/2/3 updated with the real, confirmed field names in place of the working
      hypothesis. Implementation (tasks 2 onward) must use these confirmed names, not any earlier
      placeholder.

## 2. Decode layer

- [ ] 2.1 In `src/services/entryPackage/orderQueryResponseDecoder.ts`, add `BybitChildOrderCandidate`
      type (`orderLinkId`, `orderId`, `parentOrderLinkId`, `stopOrderType`, `createType`, `orderStatus`,
      `triggerPrice`, `qty`, `leavesQty`) and `decodeChildOrderListResponse()` (design.md Decision 2),
      reusing the existing private `readOptionalStringField`/`isPositiveOrEmptyExactDecimal`/
      `isNonNegativeOrEmptyExactDecimal` helpers already in this file. An empty `orderLinkId` is a
      legitimate, expected value (confirmed fact 2) — never rejected as invalid.
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
      decodes both via `decodeChildOrderListResponse()` (task 2.1), concatenates, filters to
      `parentOrderLinkId === entryOrderLinkId`, **deduplicates by `orderId`** (flagging inconsistent
      duplicate evidence as `ambiguous`/`inconsistent_duplicate` rather than silently merging it), then
      classifies per design.md Decision 3.
- [ ] 4.2 No caching, no durable read or write, no internal bounded-retry loop (design.md Decision 1) —
      one fresh pair of queries per call, caller owns any retry cadence, including how it interprets the
      history propagation lag (confirmed fact 8) against a `"none"`/`"partial_pair"` result.

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
      correctness, fail-closed classification (including deduplication and the propagation-lag caveat),
      no new durable state, and no production behavior change, phrased around behavior/invariants rather
      than literal field names.

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
- [ ] 7.7 `resolveOwnAttachedProtection`: a candidate whose `stopOrderType` does not map to either known
      role value → `{ kind: "ambiguous", reason: "unclassified_role" }`.
- [ ] 7.8 `resolveOwnAttachedProtection`: attribution correctly excludes a same-`(category,symbol)`
      sibling's own children (synthetic multi-owner fixture, two different entry `orderLinkId`s, each
      with its own stop/take candidates present in the same symbol-scoped query result) — each own-call
      returns only its own pair, never the sibling's.
- [ ] 7.9 `resolveOwnAttachedProtection`: the same `orderId` appears in both the realtime and history
      query results with identical evidence → deduplicated to a single candidate, not double-counted as
      `duplicate_role`.
- [ ] 7.10 `resolveOwnAttachedProtection`: the same `orderId` appears in both query results with
      **inconsistent** evidence (differing `stopOrderType` or `qty` between the two sources) →
      `{ kind: "ambiguous", reason: "inconsistent_duplicate" }`.
- [ ] 7.11 `resolveOwnAttachedProtection`: a terminal leg (`orderStatus: "Deactivated"`, `leavesQty:
      "0"`, `qty` at its original value) found only via the history query is still attributed correctly —
      `qty` is read from the terminal record as-is, not assumed zeroed.
- [ ] 7.12 `getOrderHistoryForSymbol`/`getActiveOrders` payload-shape tests against fixtures — confirms
      the request omits `orderLinkId` and is scoped by `category`/`symbol` alone.
- [ ] 7.13 `tpslMode: "Partial"` payload-construction function: payload-shape test against a fixture,
      isolated from `mapEntryPackageToBybit()`'s own tests.
- [ ] 7.14 Full regression: `entryPackageApplicationService.test.ts`, `protectionApplicationService.test.ts`,
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
