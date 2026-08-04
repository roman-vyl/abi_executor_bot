## Why

`instrumentTradingRulesProvider.ts`'s `parseInstrumentTradingRules()` (called
from `BybitInstrumentTradingRulesProvider.getRules()`, the source of
`minOrderQty`/`qtyStep`/`minNotionalValue` for `FixedMinimumPositionSizeCalculator`)
reads Bybit's `instruments-info` response with the same permissiveness the
order-confirmation path had before `abi-entry-package-confirmation-response-validation-v1`:
it takes `result.list[0]` unconditionally, never checks how many rows came
back, never checks `result.category`, never checks the row's `symbol`, and
accepts any non-empty string for each numeric field without checking sign,
zero, or decimal well-formedness. A malformed or wrong-instrument response
(the wrong `result.list[0]`, a stale/rotated response body, a Bybit-side
bug) is silently trusted, and its numbers flow straight into the quantity
calculation and then into a real order sent to the exchange. This change
closes that gap the same way the order-confirmation and order-query paths
were already closed, so both external read-boundaries this contour depends
on — trading rules in, order confirmation out — validate what they receive
before anything downstream acts on it.

## What Changes

- Add `src/exchange/instrumentTradingRulesResponseDecoder.ts`: a pure
  `decodeInstrumentTradingRulesResponse({ response, expected: { category,
  symbol } })` function, scoped specifically to the `instruments-info`
  response shape (not a general Bybit response parser), returning either
  `{ ok: true, rules: { minOrderQty, qtyStep, minNotionalValue } }` or
  `{ ok: false, reason }` with a typed reason.
- **`category` is scoped to `linear` only in this change.** Bybit's `spot`
  `lotSizeFilter` is a materially different schema (`basePrecision` and
  `minOrderAmt`, no `qtyStep`, `minOrderQty` marked deprecated by Bybit) —
  not the same three fields under a different name. `expected.category ===
  "spot"` is rejected as unsupported before any field parsing, the same
  fail-closed `internal_error` outcome as any other decode failure. Mapping
  `basePrecision`/`minOrderAmt` into sizing is a separate, deliberate Spot
  sizing decision, not something this response-validation change should
  improvise. `getRules()`'s existing `"linear" | "spot"` signature is
  unchanged; `spot` is reachable today whenever the resolved ticker has no
  `.P` suffix (`ExchangeInstrumentResolver`), so this is a real, not
  hypothetical, path.
- The decoder accepts only a structurally well-formed, identity-matching,
  single-row `linear` response: `response`/`result` are objects,
  `result.category` equals `expected.category`, `result.list` is an array
  of exactly one object row whose `symbol` equals `expected.symbol`, and
  that row's `lotSizeFilter` is an object.
- Numeric fields are validated with `compareDecimal` from
  `src/domain/exactDecimal.ts` (the same arithmetic-safe parser
  `ceilToStep`/`ceilRatioToStep` already use for sizing), wrapped in
  `try/catch` since `compareDecimal` throws on non-parseable text or an
  out-of-range exponent: `minOrderQty` and `qtyStep` must be a string where
  `compareDecimal(value, "0") > 0` (throws, `"0"`, or negative all fail);
  `minNotionalValue` must be a string where `compareDecimal(value, "0") >=
  0` (`"0"` is valid — it means the minimum quantity is driven by
  `minOrderQty` alone, which the calculator already handles unchanged).
  **Not** `isPositiveExactDecimalText`/`isNonNegativeExactDecimalText` from
  `src/domain/entryPackageApi.ts`: those check grammar and sign only, with
  no bound on exponent magnitude (by design — see that file's comment on
  why the classifier is total). A value like `"1e999"` passes that
  grammar-only check, then throws inside `ceilToStep`/`ceilRatioToStep`
  during sizing — and if it had already been cached, every subsequent
  request for that instrument would hit the same throw until the TTL
  expired. Validating with `compareDecimal` itself closes that gap: a value
  the decoder accepts is, by construction, a value the sizing arithmetic
  can already consume.
- Rewrite `BybitInstrumentTradingRulesProvider.getRules()` to call the new
  decoder instead of `parseInstrumentTradingRules()`/`readInstrumentListItem()`/
  `readRecordString()`, which are deleted. On `ok: true`, cache the returned
  rules under the existing `category:symbol` TTL cache key exactly as today.
  On `ok: false`, do **not** write to the cache, and throw the same shape of
  error `getRules()` already throws for a lookup failure — the calling
  application service already maps that to `internal_error` and never
  calculates a quantity or calls `createOrder` from it, so this change adds
  no new error path, only a stricter gate in front of the existing one.
- A failed decode never touches the TTL cache, so the very next call for
  that `category:symbol` retries Bybit rather than reusing a poisoned or
  absent cache entry; a successful decode for one `category:symbol` has no
  effect on any other cache entry.

## Capabilities

### Modified Capabilities
- `entry-package-execution`: the "genuinely executable" quantity
  requirement now also requires that the exchange trading rules feeding
  that calculation come from a structurally valid, correctly-identified,
  `linear`-category `instruments-info` response — a malformed,
  wrong-instrument, arithmetic-unsafe, or `spot`-category response SHALL be
  rejected rather than trusted, with the same fail-closed `internal_error`
  outcome the rest of entry-package execution already uses for exchange
  read failures.

## Impact

- New: `src/exchange/instrumentTradingRulesResponseDecoder.ts` + unit tests.
- Modified: `src/exchange/instrumentTradingRulesProvider.ts` (`getRules()`
  calls the new decoder; `parseInstrumentTradingRules`/`readInstrumentListItem`/
  `readRecordString` deleted; TTL cache write moves behind a successful
  decode only).
- Not modified: `PositionSizeCalculator` port, `FixedMinimumPositionSizeCalculator`
  formula, `risk_multiplier` semantics, `EntryPackageExecutionRecord`,
  `EntryPackageApplicationService` decision table, order confirmation,
  open-position lookup, the entry-package HTTP DTO, Runtime, the first-fill
  sender, or any legacy `/signals`/`/intents/*` code.
- Explicitly out of scope: any `spot` `lotSizeFilter` field mapping
  (`basePrecision`, `minOrderAmt`) or Spot sizing support — `spot` remains
  fail-closed/unsupported for Live V1 sizing after this change, exactly as
  it effectively is today (a malformed-response throw), just for an
  explicit, typed reason instead of an incidental parse failure.
