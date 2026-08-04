## 1. Decoder

- [ ] 1.1 Create `src/exchange/instrumentTradingRulesResponseDecoder.ts` with
      `decodeInstrumentTradingRulesResponse({ response, expected: { category,
      symbol } })`, a typed failure-reason union, and the
      `InstrumentTradingRules` shape (`minOrderQty`, `qtyStep`,
      `minNotionalValue`) as its success payload.
- [ ] 1.2 Validate envelope shape: `response` is an object, `result` is an
      object, `result.category === expected.category`, `result.list` is an
      array, `result.list.length === 1`, the row is an object, `row.symbol
      === expected.symbol`, `row.lotSizeFilter` is an object.
- [ ] 1.3 Validate `minOrderQty`/`qtyStep` are strings passing
      `isPositiveExactDecimalText` (imported from
      `src/domain/entryPackageApi.ts`); validate `minNotionalValue` is a
      string passing `isNonNegativeExactDecimalText` from the same module.
- [ ] 1.4 Return a distinct typed failure reason for each rejection case
      (missing/wrong-shape envelope, category mismatch, list not array,
      wrong row count, malformed row, symbol mismatch, missing
      `lotSizeFilter`, invalid `minOrderQty`, invalid `qtyStep`, invalid
      `minNotionalValue`) so tests can assert on the specific cause.

## 2. Provider wiring

- [ ] 2.1 In `src/exchange/instrumentTradingRulesProvider.ts`, replace the
      `parseInstrumentTradingRules`/`readInstrumentListItem`/
      `readRecordString` call chain in `getRules()` with a call to
      `decodeInstrumentTradingRulesResponse`, passing `{ category, symbol }`
      as `expected`.
- [ ] 2.2 On a successful decode, cache the returned rules under the
      existing `` `${category}:${symbol}` `` key exactly as today (no cache
      key or TTL change).
- [ ] 2.3 On a failed decode, do not write to the cache; throw the same
      `Error` shape `getRules()` already throws for a lookup failure so
      `EntryPackageApplicationService` continues to map it to
      `internal_error` without any new error type.
- [ ] 2.4 Delete `parseInstrumentTradingRules`, `readInstrumentListItem`,
      and `readRecordString` now that nothing calls them.

## 3. Decoder unit tests

- [ ] 3.1 Valid single matching row (`category`, `symbol` match; positive
      `minOrderQty`/`qtyStep`; positive `minNotionalValue`) decodes success
      with the expected rules.
- [ ] 3.2 Valid single matching row with `minNotionalValue === "0"` decodes
      success (zero notional is a valid rule, per design.md).
- [ ] 3.3 Empty `result.list` fails with the wrong-row-count reason.
- [ ] 3.4 Multiple rows in `result.list` fails with the wrong-row-count
      reason.
- [ ] 3.5 `result.category` mismatched from `expected.category` fails with
      the category-mismatch reason.
- [ ] 3.6 Row `symbol` mismatched from `expected.symbol` fails with the
      symbol-mismatch reason.
- [ ] 3.7 Missing or non-object `lotSizeFilter` fails.
- [ ] 3.8 Non-string `minOrderQty`/`qtyStep`/`minNotionalValue` (number,
      null, object) fails.
- [ ] 3.9 `minOrderQty === "0"` and negative `minOrderQty` both fail.
- [ ] 3.10 `qtyStep === "0"` and negative `qtyStep` both fail.
- [ ] 3.11 Negative `minNotionalValue` fails.
- [ ] 3.12 Malformed decimal text and exponent text (e.g. `"1e10"` if out of
      supported range, `"abc"`, `"1.2.3"`) fail for each numeric field.
- [ ] 3.13 Missing/non-object `response` and missing/non-object `result`
      fail with the envelope reason.

## 4. Provider/cache tests

- [ ] 4.1 A valid response is cached; a repeat `getRules()` call within TTL
      for the same `category:symbol` does not call the Bybit adapter again.
- [ ] 4.2 A malformed/invalid response is not cached: `getRules()` throws
      and the Bybit adapter mock records the call.
- [ ] 4.3 After a failed call, the next `getRules()` call for the same
      `category:symbol` calls the Bybit adapter again (no stale/poisoned
      cache entry).
- [ ] 4.4 Two different `category:symbol` pairs cache independently — a
      failure for one does not evict or affect a valid cached entry for the
      other.

## 5. Application-level test

- [ ] 5.1 Add or extend an `EntryPackageApplicationService`-level test where
      the Bybit `instruments-info` mock returns a malformed response
      (e.g. wrong symbol, or `minOrderQty: "0"`); assert the service
      returns `internal_error`, `createOrder` is never called on the
      exchange adapter mock, and no correlation record is written/updated
      to an applied state.

## 6. Verification

- [ ] 6.1 Run `npm test`.
- [ ] 6.2 Run `npm run typecheck`.
