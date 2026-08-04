## Context

`BybitInstrumentTradingRulesProvider.getRules(symbol, category)`
(`src/exchange/instrumentTradingRulesProvider.ts`) is the only source of
`minOrderQty`/`qtyStep`/`minNotionalValue` for
`FixedMinimumPositionSizeCalculator` (`src/risk/positionSizeCalculator.ts`,
untouched by this change). Its current parsing helpers
(`parseInstrumentTradingRules`, `readInstrumentListItem`, `readRecordString`)
take `result.list[0]` unconditionally and accept any non-empty string for
each numeric field. See proposal.md - Why for the exact gaps.

The sibling decoder this change mirrors,
`src/services/entryPackage/orderQueryResponseDecoder.ts`
(`decodeOrderQueryResponse`), already validates a different Bybit endpoint
response the same way: envelope shape, category, row cardinality, identity
match, then per-field exact-decimal sign rules. This change follows the
same shape for a different response body and a different, smaller field
set, so the two decoders read as one family rather than two unrelated
designs.

## Goals / Non-Goals

**Goals:**
- One pure, side-effect-free decoder scoped to the `instruments-info`
  response shape, returning a discriminated result instead of throwing on
  the happy path.
- Reuse the existing exact-decimal sign helpers instead of re-deriving
  decimal grammar a third time.
- Keep the TTL cache write conditional on a successful decode, so a
  transient malformed response can never poison a `category:symbol` cache
  entry for the rest of its TTL.

**Non-Goals:**
- No change to how `getRules()` is called, its signature, or its cache key
  shape (`category:symbol`, unchanged from `abi-exchange-instrument-identity-v1`).
- No change to `PositionSizeCalculator`, sizing formula, or `risk_multiplier`
  handling — the decoder only gates what data reaches that unchanged
  calculator.
- No general-purpose Bybit response parsing library. This decoder is
  specific to `instruments-info`; `decodeOrderQueryResponse` remains
  specific to `order/realtime`/`order/history`. No shared abstraction is
  introduced between them beyond the exact-decimal helpers they already
  both depend on.
- No `spot` `lotSizeFilter` field mapping (`basePrecision` → `qtyStep`,
  `minOrderAmt` → `minNotionalValue`). `spot`'s trading-rules schema is
  materially different, not a renamed version of `linear`'s three fields —
  deciding how (or whether) to size `spot` orders is a separate decision
  with its own trade-offs, out of scope for a response-validation change.

## Decisions

**Decoder returns a discriminated result, not a thrown error.**
Matches `decodeOrderQueryResponse`'s shape (`{ ok: true, rules } | { ok:
false, reason }` rather than `{ kind: "found" | ... }` — a simpler two-case
result is enough here since, unlike order confirmation, there is no
meaningful third "not found" outcome: `instruments-info` for a resolved
symbol either answers correctly or it doesn't). `getRules()` is the only
caller and already throws to signal failure to
`EntryPackageApplicationService`, so the decoder itself stays pure and lets
`getRules()` do the one translation to a thrown error, keeping the decoder
trivially unit-testable without needing to catch exceptions in tests.

**Validate numeric fields with `compareDecimal` from `exactDecimal.ts`
(wrapped in `try/catch`), not `isPositiveExactDecimalText`/
`isNonNegativeExactDecimalText` from `entryPackageApi.ts`.**
Those grammar/sign helpers are deliberately total — `analyzeExactDecimalText`'s
own comment states it applies no `MAX_ABS_EXPONENT` bound because the
Bybit position-size adapter boundary that also uses it must never throw.
That's the wrong fit here: `minOrderQty`/`qtyStep`/`minNotionalValue` feed
directly into `ceilToStep`/`ceilRatioToStep`, which parse with the
BigInt-backed `compareDecimal`/arithmetic family and *do* enforce
`MAX_ABS_EXPONENT = 100`, throwing outside it. A response containing, say,
`minOrderQty: "1e999"` would pass the grammar-only check, get cached as a
"valid" rule, and then throw on every sizing attempt for that
`category:symbol` until the cache entry expired — the exact "invalid rules
poison the cache" failure mode this change exists to prevent, just moved
one layer instead of eliminated. Validating with `compareDecimal(value,
"0")` itself (positive: `> 0`, non-negative: `>= 0`, non-string or a throw
from `compareDecimal` both count as invalid) makes "the decoder accepted
it" and "the sizing arithmetic can consume it" the same guarantee by
construction. No new decimal-validation helper is added; `compareDecimal`
already exists and is already the function `ceilToStep`/`ceilRatioToStep`
depend on.

**`category` is restricted to `linear`; `spot` fails closed as
unsupported rather than being parsed with `linear`'s field names.**
Bybit's public `instruments-info` documentation gives `spot` a different
`lotSizeFilter` shape (`basePrecision`, `minOrderAmt`; `minOrderQty`
deprecated; no `qtyStep`). Attempting to read `qtyStep`/`minNotionalValue`
off a `spot` response would either always fail (if genuinely absent,
correctly rejected but for a misleading "malformed" reason) or, worse,
silently succeed if Bybit ever includes stray/legacy fields under those
names with unrelated semantics. Rejecting `category === "spot"` outright,
before field parsing, makes the unsupported case explicit and typed rather
than an accident of the linear-shaped checks happening to fail. This
matches proposal.md's scope: `getRules(symbol, category)` already accepts
`"linear" | "spot"` (from `abi-exchange-instrument-identity-v1`), and
`spot` is reachable today for any ticker without a `.P` suffix, so this is
closing a real path, not a hypothetical one.

**Cache write happens in `getRules()`, not inside the decoder.**
The decoder has no knowledge of the cache; `getRules()` calls it, and only
on `ok: true` does it perform the existing `this.cache.set(cacheKey, ...)`
call. On `ok: false`, `getRules()` throws without touching the cache map at
all, so a prior valid cache entry for a *different* symbol is never
affected, and this symbol's next call re-queries Bybit. This is a minimal
reordering of existing provider code, not new caching logic.

## Risks / Trade-offs

- [A previously-passing malformed response silently changes behavior from
  "used" to "internal_error"] → This is the intended fail-closed change;
  proposal.md's Impact section confirms no other component's contract
  changes, so the only visible effect is that entry-package application
  now correctly reports `internal_error` for a case that should never have
  succeeded.
- [Duplication between this decoder and `orderQueryResponseDecoder.ts`
  (both re-implement envelope/category/row-cardinality checks)] → Accepted:
  the proposal explicitly scopes this to a decoder for `instruments-info`,
  not a shared parser, and the two response shapes differ enough (three
  required numeric fields vs. six optional ones with different sign rules)
  that a shared abstraction would need its own design discussion outside
  this change's scope.
- [Any live account whose resolved ticker is `spot` gets `internal_error`
  for every entry-package command instead of a (previously accidental,
  likely already-broken) sizing attempt] → Accepted and intended per
  proposal.md's Impact section: Live V1's open-position/entry-package
  contour is linear-only in practice, and an explicit typed rejection is
  strictly safer than the prior behavior, which depended on `spot`
  responses happening to fail `linear`-shaped field checks rather than
  guaranteeing it.
