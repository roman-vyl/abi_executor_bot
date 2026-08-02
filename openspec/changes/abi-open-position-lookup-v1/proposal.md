## Why

Runtime already needs an authoritative answer to "is there an open position for this
trade cycle right now" — it currently has no way to ask ABI this question at all. The
existing correlation record (`EntryPackageCorrelationRepository.get(strategy_instance_id,
trade_cycle_id)`, `src/correlation/entryPackageCorrelationRepository.ts:83-85`) is already
addressed by Runtime's full ownership pair, but its stored `status`
(`src/correlation/entryPackageExecutionRecord.ts:4-12`) is an ABI command-workflow state,
not a position-truth state — `"applied"` covers pending-unfilled, partial-fill, and
full-fill alike — and `early_execution_observation` is a one-time snapshot written during
PUT confirmation that is never refreshed, so neither can answer whether a position is open
right now. Only a live Bybit position query can. Bybit's `/v5/position/list` response
already carries the `size`, `openTime`, and `avgPrice` this route needs; ABI's adapter
today discards two of the three. This change adds a pair-addressed, read-only HTTP route
that performs the direct composite lookup and a live Bybit query, and returns nothing else
— no repository schema change, no new persisted state, and no change to the entry-package
PUT flow. The already-implemented Runtime client uses an older instance-only path and
field names and needs its own coordinated change, which is out of scope here.

## What Changes

- Add `GET /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position`:
  a new, read-only ABI HTTP route addressed by the same ownership pair as the existing
  entry-package PUT route.
- Add an application-layer open-position resolution use case that performs a direct
  composite `EntryPackageCorrelationRepository.get()` lookup, classifies the record's
  stored `status`, and — for any state that does not durably prove the absence of exchange
  exposure — issues a live Bybit `/v5/position/list` query using the record's own
  `exchange_category`/`exchange_symbol` (never the deployment's global configured
  category).
- Extend the Bybit adapter's position query/DTO to accept an explicit `category` parameter
  and to carry `avgPrice` and `openTime` from the already-available raw response, instead
  of discarding them.
- Define the response contract: `position_open: bool`, `first_fill_at_ms: int | null`,
  `average_entry_price: exact-decimal string | null`, with a mandatory cross-field
  invariant (both facts present together, or both `null` together). Any partial fill
  counts as an open position.
- Scope V1 to `exchange_category = linear`, Bybit one-way position mode
  (`positionIdx = 0`), and a live position side matching `record.desired_entry.side`;
  `spot`, hedge-mode rows, unexpected `positionIdx`, opposite side, and ambiguous rows all
  fail closed rather than resolve to `position_open = false`.
- Wire the new route into the existing server route chain, gated on the existing
  `EntryPackageReadiness` signal (the route reads the same recovered correlation store).

**Explicitly not in scope:** any lookup or index keyed on `strategy_instance_id` alone;
any record-selection or record-cardinality logic; any notion of a "current trade cycle"
pointer; any new persisted state or repository schema change; any change to the
entry-package PUT flow, `EntryPackageExecutionRecord`'s stored fields, or
`entry-package-execution` behavior; `base_timeframe` or `entry_bar_open_time_ms`
computation (Runtime owns `base_timeframe` and performs this on its own side); and any
Runtime-side implementation. The Runtime client (`abi-open-position-lookup-client` in the
`strategy_runtime` repo) currently calls an instance-only path with different response
field names and requires a separate, coordinated change once this ABI-side contract is
agreed.

## Capabilities

### New Capabilities
- `abi-open-position-lookup-api`: the public V1 Runtime → ABI HTTP contract for the new
  `GET .../open-position` route — path shape, opaque path-parameter handling, the
  success DTO and its cross-field invariant, exact-decimal price encoding, and documented
  error responses.
- `open-position-resolution`: the internal application/domain behavior that resolves a
  `(strategy_instance_id, trade_cycle_id)` pair to a truthful current position answer —
  direct composite record lookup, record-state classification, live Bybit query and
  validation, and fail-closed handling for every unresolved or ambiguous branch.

### Modified Capabilities
(none — this change only reads via the existing `EntryPackageCorrelationRepository.get()`
method; it does not change `entry-package-execution`'s requirements, the PUT flow, or any
persisted record field.)

## Impact

- **ABI HTTP API**: one new GET route and its request/response DTOs.
- **Application/domain**: one new read-only use case (open-position resolution); no
  changes to the existing entry-package application service's write paths.
- **Bybit adapter**: `BybitPosition`/`readOpenPosition()` gain `avgPrice`/`openTime`; the
  position-query path gains an explicit `category` parameter instead of always reading
  `config.bybitCategory`.
- **Composition/readiness**: new route wired into `src/app/server.ts`'s existing route
  chain, gated on the existing `EntryPackageReadiness` instance; no new persistence owner.
- **OpenAPI and tests**: a new operation and focused test coverage, added during
  implementation (`/opsx:apply`), not as part of this proposal.
- **Out of impact**: `EntryPackageCorrelationRepository`'s schema/index, the entry-package
  PUT route and its application service write paths, and any Runtime-repo file (a separate
  coordinated change is required there).
