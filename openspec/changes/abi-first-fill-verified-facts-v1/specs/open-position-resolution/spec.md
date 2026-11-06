## MODIFIED Requirements

### Requirement: first_fill_at_ms is the earliest of this cycle's own entry order's own executions, never a canonical strategy-bar value
When reporting an open position, `first_fill_at_ms` SHALL be the earliest execution timestamp among this
cycle's own entry order's own individually-timestamped executions — never a value ABI has normalized,
rounded, or otherwise mapped to any strategy timeframe, interval, candle grid, or bar boundary, and never
derived from any field describing an order's current or most-recently-observed state (such value cannot be
trusted to represent the *first* fill once more than one execution has occurred). ABI SHALL NOT introduce,
read, derive, or depend on any strategy timeframe/interval/grid concept to produce this value. ABI SHALL
capture this value durably exactly once per trade cycle, the first time this cycle's own evidence proves a
fill occurred and no value is captured yet, by first querying every one of this order's own executions through the existing REST path, or, if that capture cannot establish a value, verifying a complete local execution set under verified-first-fill-evidence, and
taking the minimum of their own timestamps — never by inspecting only the first-returned or
most-recently-observed execution. Once captured, `first_fill_at_ms` SHALL be immutable: no later
observation, however different, SHALL overwrite an already-captured value.

#### Scenario: The value is captured once, as the true minimum across this order's own executions
- **WHEN** ABI observes, for the first time, that this cycle's own entry order has a nonzero cumulative
  fill and no `first_fill_at_ms` is captured yet
- **THEN** ABI durably captures `first_fill_at_ms` as the minimum execution timestamp among every one of
  this order's own executions it can find
- **AND** this value is never derived from, or normalized against, any strategy timeframe or bar boundary

#### Scenario: An order with more than one execution before its first observation still resolves to the true first fill
- **WHEN** this cycle's own entry order has already accumulated more than one execution by the time ABI
  first observes it, and those executions have different timestamps
- **THEN** ABI captures `first_fill_at_ms` as the earliest of those timestamps, not the timestamp of
  whichever execution ABI's own observation happened to see most recently

#### Scenario: The captured value is stable across repeated requests
- **WHEN** `GET .../open-position` is called again for a pair whose `first_fill_at_ms` is already captured,
  and this cycle's own entry order has since accumulated further executions
- **THEN** ABI returns the originally captured value unchanged, not a value reflecting the more recent
  executions

#### Scenario: A pre-existing durable record without a captured value is backfilled once
- **WHEN** a durable record already shows a final, nonzero own-cycle fill but has never captured
  `first_fill_at_ms`
- **THEN** ABI first performs the existing fresh REST query of this order's own executions and only if it cannot establish a timestamp attempts the verified local proof to capture the value, even though
  the stored fill facts themselves need no refresh


### Requirement: first_fill_at_ms's capture accumulates every page of this order's own executions before computing a value, never assuming their returned order
When capture uses the initial REST path, ABI SHALL retrieve every available page of this cycle's own entry
order's own executions before computing the minimum timestamp, following the exchange's own pagination
cursor to completion, and SHALL NOT assume executions are returned in any particular chronological order.
ABI SHALL NOT compute or accept a candidate value derived from an incomplete set of pages.

#### Scenario: A later page containing the true earliest execution is still found
- **WHEN** this order's own executions span more than one page, and the earliest execution by timestamp is
  not on the first page returned
- **THEN** ABI's captured `first_fill_at_ms` reflects that earliest execution regardless of which page it
  was returned on

#### Scenario: An unbounded or excessive page count fails closed rather than using a partial result
- **WHEN** this order's own executions span more pages than ABI's bounded pagination allows
- **THEN** ABI does not compute `first_fill_at_ms` from the pages it did retrieve
- **AND** if the subsequent verified local proof is also unavailable, ABI returns `internal_error` without a durable write


### Requirement: A first-fill capture that finds no executions for an order already proven filled fails closed
Since `first_fill_at_ms` capture is only ever attempted after this cycle's own evidence already proves a
nonzero fill, if no saved timestamp or verified local proof is available, ABI SHALL treat a REST capture query that finds no executions for this order as a contradiction —
never as proof the order has no fill, and never as grounds to silently omit or fabricate
`first_fill_at_ms`. ABI SHALL fail closed in this case without a durable write.

#### Scenario: An empty execution result for an order with proven fill facts fails closed
- **WHEN** this cycle's own fill facts already show a nonzero cumulative fill, no verified local proof is available and a REST capture query finds no
  executions at all for this order's own identity
- **THEN** ABI does not report `position_open: true` with a fabricated or omitted `first_fill_at_ms`
- **AND** ABI returns `internal_error` without durably writing `first_fill_at_ms`


### Requirement: The entry order identifiers come only from the proof's own order identity
For an open result, ABI SHALL take `entry_order_link_id` from the current binding's `order_link_id`, the identity the fill proof used for its order read and for the `first_fill_at_ms` execution query, and never from `binding_history`. ABI SHALL take `entry_order_id` only from a Bybit order row matched by that `orderLinkId`:

- on the fresh path, from the `orderId` of the row whose read produced the open result;
- on the reuse path (a final stored `early_execution_observation`), from the observation's `order_id`, which the apply-time confirmation writes from the `orderId` of the same row the observation is built from;
- `null` when that row had no usable `orderId`, or the stored observation has no `order_id`.

ABI SHALL NOT use the correlation record's `order_id` captured from the create acknowledgement, SHALL NOT issue an additional exchange request to obtain an identifier, and SHALL NOT change how `position_open`, `average_entry_price` or any partial-fill outcome is determined. An observation without the `order_id` key SHALL be read as `order_id: null`, and no stored record SHALL be rewritten for this.

#### Scenario: Fresh path
- **WHEN** the stored observation is `null` or not final, and the fresh read of this cycle's own entry order shows a fill
- **THEN** `entry_order_id` is that row's `orderId`, or `null` if the row has none

#### Scenario: Entry filled at placement
- **WHEN** the apply-time confirmation found this cycle's own entry order filled and stored a final observation with `order_id`
- **THEN** a later lookup reuses the observation without an exchange call and returns that `order_id` as `entry_order_id`

#### Scenario: Stored observation without an order id
- **WHEN** the reused final observation has no `order_id`
- **THEN** `entry_order_id` is `null`, no exchange call is made for it, and the create-acknowledgement `order_id` is not returned

#### Scenario: Partial fill
- **WHEN** this cycle's own entry order is partially filled and still live
- **THEN** the result is open exactly as before, and the identifiers name that same order


The first-fill source SHALL follow verified-first-fill-evidence; locally stored facts SHALL NOT supply response entry identifiers in place of the already-authoritative current own-order proof.

## ADDED Requirements

### Requirement: Local first-fill fallback never uses a live entry cumulative snapshot
Any SQLite timestamp fallback in this capability SHALL require terminal-entry eligibility under verified-first-fill-evidence before reading local facts or links. It SHALL NOT change existing REST capture for live partial fills or existing branch-specific failure/best-effort semantics.

#### Scenario: REST capture is empty while the entry remains live
- **WHEN** no timestamp is saved, REST capture cannot establish one and the entry is PartiallyFilled or otherwise not proven terminal
- **THEN** ABI SHALL NOT read SQLite to capture first_fill and SHALL retain the existing outcome of that branch
