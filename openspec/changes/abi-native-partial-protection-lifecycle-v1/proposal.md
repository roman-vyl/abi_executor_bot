## Why

`docs/virtual-exposure-ownership-delivery-plan.md` (revisions v16/v17) closed the two open technical
questions this change depends on, both proven against real Bybit Demo responses, not assumed:

1. **Direct amend, not cancel/recreate.** A `tpslMode: "Partial"` protection child can be changed in
   place via `POST /v5/order/amend` by its exact `orderId` (available from
   `abi-native-partial-protection-attribution-v1`'s `resolveOwnAttachedProtection()`). `orderId`,
   `parentOrderLinkId`, `stopOrderType`, `createType`, and `tpslMode` all survive amend; `triggerPrice`
   is independently adjustable per leg; `qty` resizes both down and up; amending one leg's `qty`
   **automatically synchronizes** the sibling leg's `qty`; no new children are created and no
   duplicate-role children appear; Change 6's classifier still returns `attributed` after amend.
2. **`take_price = null` → surrogate TAKE, not a missing leg.** A dedicated stop-only spike
   (`docs/spikes/bybit-demo-native-partial-stop-only.md`, evidence commit
   `4b581220e30bce1c65ebc3f1fa945753cf0d435a`) proved attached native Partial protection only exists as a
   single, cancel-coupled `STOP + TAKE` pair: cancelling the exact TAKE child deactivates the STOP child
   too; amending a TAKE child's `takeProfit` to `"0"` is an observed no-op, not removal; and
   `/v5/position/trading-stop` can create a genuine native Partial stop-only state, but the result's
   `parentOrderLinkId` is empty — unattributable to the owning entry order. `take_price = null` therefore
   stays the logical HTTP semantics "strategy take disabled," but the exchange representation always
   stays a full attributable `STOP + TAKE` pair — the TAKE leg is materialized as a deterministic,
   far-away, dormant surrogate.

This change is `abi-native-partial-protection-lifecycle-v1` — the second of the three changes that
replace the original cancel/recreate design (`abi-native-partial-protection-attribution-v1` →
**this change** → `abi-native-partial-protection-cutover-v1`). It builds a production-inert
**reconciliation lifecycle**: given a desired protection state (`stop_price`/`take_price` from
`PUT .../protection`, `qty` from this cycle's own authoritative cumulative fill), compare it against the
actually observed attributable native Partial children (`resolveOwnAttachedProtection()`), and — if they
differ — amend the existing children in place to match. It never creates or cancels an order. Guard from
`abi-same-side-virtual-exposure-ownership-v1` stays up, entry create stays on `tpslMode: "Full"`, and
`PUT .../protection`'s production-decision path is untouched: this change's reconciler is built and fully
tested, but wired to nothing production calls. Activation is `abi-native-partial-protection-cutover-v1`'s
job alone.

**Two of four design questions this proposal must answer are resolved without further gating**
(triggered/race discipline, minimal pair-wide qty write-plan) **because they depend only on ABI-side
logic, not on unverified exchange behavior.** A third (multi-fill representability) resolves to "no
special-casing needed" — the reconciler's existing fail-closed behavior on anything other than
`none`/`attributed` already covers it. **The fourth (the exact surrogate TAKE distance) is answered with
a concrete default and a verification task**, not a fresh multi-day spike: the master plan explicitly
forbids inventing an unverified percentage and shipping it as if proven, so the default below is
documented as provisional, gated by a bounded pre-implementation check against Bybit's own accepted price
range for the instrument, not by another full Demo exploration.

**OCO-after-amend remains `NOT PROVEN`** — neither spike checked whether Bybit atomically neutralizes a
sibling leg when the other fills, after both legs have been through amend. This change does not depend on
that guarantee (it never assumes a leg's sibling has been cleaned up; it always re-queries fresh evidence
before acting) but flags it, unchanged from the master plan, as an evidence item `abi-native-partial-
protection-cutover-v1` needs if its close/activation semantics come to rely on it.

## What Changes

- New adapter primitive: `POST /v5/order/amend`, scoped to `{category, symbol, orderId, triggerPrice?,
  qty?}` — the only Bybit write this change introduces.
- `InstrumentTradingRules` (`instrumentTradingRulesResponseDecoder.ts`) gains `tickSize`, decoded from
  the same `/v5/market/instruments-info` response `BybitInstrumentTradingRulesProvider` already queries
  for `minOrderQty`/`qtyStep`/`minNotionalValue` — no new Bybit query, an additional field read from an
  existing one.
- New price-side step-rounding primitive (`floorToStep`, alongside the existing `ceilToStep` in
  `exactDecimal.ts`) — needed so a computed surrogate price can be rounded consistently away from the
  reference price in either direction (up for a LONG surrogate, down for a SHORT surrogate).
- New reconciliation primitive: given a trade cycle's desired protection state and the actual
  attributable children Change 6's `resolveOwnAttachedProtection()` reports, computes the minimal set of
  `amend` calls needed (reusing the confirmed pair-wide `qty` sync — never more than one `qty`-only amend
  call is issued), sends them, and re-verifies with a fresh, independent read-back before reporting
  success. Never creates or cancels an order.
- Surrogate TAKE price computation for `take_price = null`: deterministic, derived from this cycle's own
  `average_entry_price` (Change 1), tick-normalized, side-aware (far above for long, far below for
  short), idempotent for a repeated identical intent.
- A new, non-production-decision method on `ProtectionApplicationService` exercising the full
  reconciliation flow — `ProtectionApplicationService.process()` (the production HTTP path) is not
  touched; the existing `setTradingStop`/`tpslMode: "Full"` path and the
  `shared_scope_protection_unsupported` guard continue to serve every real request exactly as before.

## Capabilities

### Modified Capabilities

- `protection-execution`: gains a new, production-inert, fully tested reconciliation requirement set
  (desired-vs-actual comparison, in-place amend, surrogate TAKE materialization, fresh-evidence
  discipline) alongside the existing, byte-for-byte-unchanged `PUT .../protection` production behavior.

### New Capabilities

None. This change extends `protection-execution`, not a new capability — unlike
`abi-native-partial-protection-attribution-v1`, it has no independent read-only concern worth its own
capability boundary; it is squarely "how protection gets applied," which is what `protection-execution`
already means.

## Impact

- Public HTTP contract: unchanged. `PUT .../protection`'s request/response shape, and
  `shared_scope_protection_unsupported`'s continued return for multi-owner scope, are untouched.
- Production behavior: unchanged. `ProtectionApplicationService.process()` is not modified; the new
  reconciler is reachable only through a distinct method tests call directly.
- New Bybit write traffic: one new write shape (`/v5/order/amend`) that does not exist in this codebase
  today; used only by the new, unwired reconciler.
- Correlation store on-disk shape: unchanged. No new field on `EntryPackageExecutionRecord`.
- Prerequisite relationship: this is the foundation `abi-native-partial-protection-cutover-v1` activates.
  Neither the mapping cutover, the admission-guard removal, nor the
  `shared_scope_protection_unsupported` removal happens in this change.
- Remaining precondition for `abi-native-partial-protection-cutover-v1`, not this change: OCO-after-amend
  stays `NOT PROVEN`; the surrogate TAKE distance default below is provisional pending the bounded
  verification task in `tasks.md`, not a second full spike.
