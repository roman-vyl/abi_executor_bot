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

**Reuse `isPositiveExactDecimalText`/`isNonNegativeExactDecimalText` from
`src/domain/entryPackageApi.ts` rather than the locally-defined
`isPositiveOrEmptyExactDecimal`/`isNonNegativeOrEmptyExactDecimal` helpers
in `orderQueryResponseDecoder.ts`.**
The order-query decoder's helpers additionally accept `""` because several
of its fields are legitimately absent at certain order states (see that
file's comment). None of the three `instruments-info` fields are ever
legitimately absent — `lotSizeFilter` either has all three or the response
is malformed — so the plain (non-"-or-empty") domain helpers are the
correct, already-existing fit; no new decimal-validation helper is added.

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
