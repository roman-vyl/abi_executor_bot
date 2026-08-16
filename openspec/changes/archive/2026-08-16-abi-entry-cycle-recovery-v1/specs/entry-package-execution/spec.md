## MODIFIED Requirements

### Requirement: A desired-entry change on an existing binding is served by cancellation only
When an existing trade cycle has a live or confirmed order and the desired entry changes
in any way (side, price, quantity, stop, or take), ABI SHALL treat the request identically
to an explicit CANCEL: it SHALL cancel the existing exchange order, confirm the
cancellation, and acknowledge `entry_package_absent`. ABI SHALL NOT amend the existing
order in place, and SHALL NOT create a new order as part of the same request. A new
desired entry is applied only by a subsequent, independent PUT for a trade cycle with no
existing binding.

#### Scenario: Any desired-entry change cancels rather than replaces
- **WHEN** a PUT request specifies a non-null `desired_entry` for a trade cycle that
  already has a live or confirmed order, and that `desired_entry` differs from the
  currently stored one
- **THEN** ABI SHALL cancel the existing exchange order, confirm the cancellation, and
  return `entry_package_absent`
- **AND** ABI SHALL NOT create a new order in the same request

#### Scenario: An identical repeat PUT still revalidates rather than cancelling
- **WHEN** a PUT request specifies a non-null `desired_entry` identical to the currently
  stored one
- **THEN** this Requirement SHALL NOT apply, and ABI SHALL instead revalidate the existing
  binding per the existing repeat-PUT revalidation requirement

### Requirement: ABI cancels or confirms absence of a desired entry package
When the desired entry is null, ABI SHALL cancel any live order for that trade cycle and
acknowledge absence, or confirm absence directly when nothing was ever live.

#### Scenario: Cancel a live order
- **WHEN** `desired_entry` is null and a live order exists for the trade cycle
- **THEN** ABI SHALL cancel the exchange order and return `entry_package_absent` only
  after the cancellation is durably confirmed

#### Scenario: Confirm already-absent state
- **WHEN** `desired_entry` is null and no order has ever existed, or the trade cycle is
  already confirmed absent
- **THEN** ABI SHALL return `entry_package_absent` without asserting that a cancellation
  action occurred

#### Scenario: A query failure while confirming a cancellation never confirms absence
- **WHEN** ABI queries the exchange to confirm a cancellation and the query fails or times
  out, rather than cleanly reporting the order gone
- **THEN** ABI SHALL NOT return `entry_package_absent` on the basis of that failure, and
  SHALL treat the cancellation as unconfirmed

#### Scenario: A structurally malformed response while confirming a cancellation never confirms absence
- **WHEN** ABI queries the exchange to confirm a cancellation and the response is
  structurally malformed (per the malformed-response conditions defined for confirming
  package application) rather than a cleanly-reported empty list or clean terminal
  status, on either the realtime or history query
- **THEN** ABI SHALL NOT return `entry_package_absent` on the basis of that response, and
  SHALL treat the cancellation as unconfirmed

#### Scenario: An unrecognized realtime order status while confirming a cancellation never confirms absence
- **WHEN** ABI queries the exchange to confirm a cancellation and the realtime query
  returns a single, correctly-identified row with an unrecognized `orderStatus`
- **THEN** ABI SHALL NOT return `entry_package_absent` on the basis of that result, even
  if a subsequent history query cleanly reports the order absent

#### Scenario: A cancel transport failure is durably recorded as unknown, not silently left pending
- **WHEN** ABI dispatches a cancel command and the exchange call throws or times out
  before ABI can classify the outcome
- **THEN** ABI SHALL durably record `status: "unknown"` for the binding before returning a
  safe error
- **AND** `pending_action` SHALL remain `"cancel"` so a subsequent repeat PUT can safely
  resend it

#### Scenario: A repeat cancel-intent PUT revalidates before resending
- **WHEN** a PUT request specifies a null `desired_entry` and the stored record's status
  is not already `absent` or `terminal_unfilled`
- **THEN** ABI SHALL query the exchange for the existing order's current state before
  resending the cancel command
- **AND** ABI SHALL resend cancel only if that query confirms the order is still live
- **AND** if the query confirms the order is already terminal, ABI SHALL record the
  confirmed outcome without resending
- **AND** if the query is inconclusive, ABI SHALL record `status: "unknown"` without
  resending

### Requirement: Entry-package Bybit calls use the resolved category, not global configuration
For entry-package create/cancel/query payloads and instrument trading-rules lookup, ABI
SHALL source `category` from the resolved (or, for an existing binding, previously
stored) exchange instrument identity, rather than from the global Bybit category
configuration value.

#### Scenario: Create payload category comes from the resolved identity
- **WHEN** ABI builds the create payload for a new binding
- **THEN** the payload's `category` SHALL equal the resolved identity's `category`,
  regardless of the global Bybit category configuration value

#### Scenario: Instrument trading-rules lookup receives the resolved category
- **WHEN** ABI looks up instrument trading rules for a resolved symbol
- **THEN** the lookup SHALL be performed for that symbol's resolved `category`, and a
  lookup for the same symbol under a different category SHALL NOT reuse a cached result
  from this one

#### Scenario: The underlying Bybit instruments-info call receives the same category
- **WHEN** the trading-rules lookup queries Bybit's instruments-info endpoint
- **THEN** that exchange call SHALL be made with the resolved `category`, not the global
  Bybit category configuration value, so a cache key of `spot:BTCUSDT` can never be
  backed by a `linear` exchange response

### Requirement: The correlation record stores the resolved category for reuse
The entry-package correlation record SHALL durably store `exchange_category` alongside
the existing `exchange_symbol`, so that a later cancel or query against the same binding
uses the category it was originally resolved with, without re-resolving the ticker.

#### Scenario: A newly created binding's record includes its category
- **WHEN** ABI durably persists the record for a new binding
- **THEN** the record SHALL include the resolved `exchange_category` alongside
  `exchange_symbol`

#### Scenario: Cancel, realtime query, and history query all reuse the stored category
- **WHEN** ABI cancels or queries (realtime or history) an existing binding
- **THEN** every one of those payloads SHALL use that binding's stored
  `exchange_category` together with its stored `exchange_symbol`, rather than the global
  Bybit category configuration value or a fresh resolution

### Requirement: Metadata-only changes update the record without cancelling or recreating the order
When only `source_plan_bar_open_time_ms` or `locked_exit_profile` differ from the
previously applied desired entry, with side, price, quantity, stop, and take unchanged,
ABI SHALL durably update the stored desired entry and revalidate the existing order
without sending a cancel or create request.

#### Scenario: Metadata-only change durably updates without an exchange write
- **WHEN** a PUT request changes only `source_plan_bar_open_time_ms` or
  `locked_exit_profile` relative to the previously applied desired entry
- **THEN** ABI SHALL durably persist the updated desired entry and perform a bounded
  revalidation of the existing order without sending a cancel or create request to the
  exchange

### Requirement: Each trade cycle receives a unique, stable order identity per generation
ABI SHALL derive a unique exchange order identity for each distinct order it creates,
scoped to the owning strategy instance, trade cycle, order role, and a generation counter
that only advances when a physically new order is created.

#### Scenario: Sequential trade cycles do not collide
- **WHEN** two different trade cycles belong to the same strategy instance
- **THEN** ABI SHALL derive different order identities for each cycle's order

#### Scenario: Retrying an ambiguous attempt reuses the same identity
- **WHEN** a repeated request follows a transport failure or timeout for the same desired
  package
- **THEN** ABI SHALL reuse the already-reserved order identity rather than generating a
  new one

#### Scenario: An unconfirmed attempt is recovered by resending, not just re-querying
- **WHEN** a previous create attempt's outcome was never durably confirmed (e.g. ABI
  restarted or lost the response mid-flight), a later identical request arrives, and the
  exchange genuinely has no record of that attempt anywhere
- **THEN** ABI SHALL resend the same command against the exchange, reusing the
  already-reserved order identity, rather than only re-querying indefinitely without ever
  resending

#### Scenario: An attempt is not resent while its true exchange state is merely unclear
- **WHEN** a previous attempt's outcome could not be confirmed, but the inconclusive
  result came from a failed or inconsistent query rather than every query cleanly
  reporting the order absent
- **THEN** ABI SHALL NOT resend the command, since the order may already exist on the
  exchange, and SHALL instead return a safe internal error

### Requirement: ABI durably records correlation state before acknowledging success
ABI SHALL durably persist a record of the intended action before contacting the exchange,
and SHALL durably commit the confirmed outcome before returning any success
acknowledgement.

#### Scenario: Provisional record exists before the exchange is contacted
- **WHEN** ABI begins processing a create or cancel command
- **THEN** ABI SHALL durably persist a record of the intended action before sending any
  request to the exchange

#### Scenario: Success is never acknowledged before durable commit
- **WHEN** ABI is about to return `entry_package_applied` or `entry_package_absent`
- **THEN** ABI SHALL have already durably committed the confirmed state, such that a
  crash immediately before that commit cannot have produced a successful response

### Requirement: ABI confirms package application with field-level accuracy before acknowledging success
After the exchange accepts a create, and when ABI revalidates the same binding for a
repeat PUT or metadata-only update, ABI SHALL verify within a bounded window that the
read-back identifies the expected `category`, `symbol`, and `orderLinkId`, reports a
recognized live or filled state, carries the expected quantity, and contains structurally
valid exchange-reported numeric fields. The exchange-reported `triggerPrice`, `stopLoss`,
and `takeProfit` SHALL be treated as the authoritative exchange representation and SHALL
NOT be required to equal the raw desired-entry decimal text. This requirement's only
change from the currently active canonical-price-confirmation semantics
(`abi-entry-package-exchange-canonical-confirmation-v1`) is the removal of "or amend" from
its trigger clause, since this change removes physical amend entirely — the identity,
quantity, state, and exchange-canonical-price rules are otherwise unchanged and are not
being reintroduced as raw decimal equality.

#### Scenario: Exchange-canonical prices do not create false ambiguity
- **WHEN** a successful create is read back for the same correctly identified order with
  the expected quantity and a recognized state, but Bybit represents `triggerPrice`,
  `stopLoss`, or `takeProfit` with decimal text different from the raw desired-entry text
- **THEN** ABI SHALL accept those structurally valid exchange-canonical price fields and
  SHALL NOT make confirmation ambiguous solely because their text or numeric values differ
  from the raw desired-entry fields

#### Scenario: Identity quantity malformed or state mismatch fails closed
- **WHEN** bounded confirmation cannot establish the expected order identity, expected
  quantity, a recognized live or filled state, or structurally valid exchange-reported
  numeric fields
- **THEN** ABI SHALL NOT return `entry_package_applied` and SHALL fail confirmation safely

#### Scenario: Ambiguous confirmation fails safely
- **WHEN** bounded confirmation cannot determine whether the package is pending, filled,
  terminal, or absent
- **THEN** ABI SHALL return a safe internal error and no success acknowledgement

#### Scenario: A query failure is never treated as confirming evidence
- **WHEN** a query to the exchange during confirmation fails or times out, rather than
  cleanly reporting a result
- **THEN** ABI SHALL NOT treat that failure as evidence of any particular exchange state,
  and SHALL return a safe internal error unless an independent, cleanly-answered query
  elsewhere confirms the outcome

#### Scenario: A structurally malformed response is never treated as absence
- **WHEN** a confirmation query's response is structurally malformed (missing or
  non-object result, missing or non-array list, more than one row for a single
  `orderLinkId`, a non-object row, or a row whose `symbol` or `orderLinkId` does not
  match the request) rather than a cleanly-reported empty list
- **THEN** ABI SHALL NOT treat that response as evidence the order does not exist, and
  SHALL treat it the same as a query failure for purposes of confirmation

#### Scenario: A response with unparseable or out-of-range numeric fields is never treated as confirming evidence
- **WHEN** a confirmation query returns a row whose `qty`, `cumExecQty`, `triggerPrice`,
  `stopLoss`, `takeProfit`, or `avgPrice` field is present but is not valid exact-decimal
  text, or violates that field's sign rule (`qty`/`avgPrice` must be strictly positive
  when present; `cumExecQty`/`triggerPrice`/`stopLoss`/`takeProfit` must be zero or
  positive when present; none may be negative)
- **THEN** ABI SHALL NOT use that row as confirming evidence and SHALL treat the query the
  same as a query failure

#### Scenario: An unrecognized order status is found but inconclusive, not malformed
- **WHEN** a confirmation query returns a single, correctly-identified row with a
  non-empty `orderStatus` value ABI does not recognize as pending, filled, or terminal
- **THEN** ABI SHALL treat the order as found rather than reject the response as
  malformed, and SHALL mark the confirmation attempt inconclusive rather than confirming
  any particular package state from it

#### Scenario: A found-but-inconclusive realtime result is never discarded by an empty history result
- **WHEN** a realtime confirmation query returns a single, correctly-identified row whose
  status is unrecognized, or is a terminal-without-fill status that falls through to the
  order-history query, and the subsequent order-history query cleanly reports the order
  absent for the entire bounded confirmation budget
- **THEN** ABI SHALL return a safe internal error rather than treating the package as
  confirmed absent, since a real order was positively found on realtime

#### Scenario: A definitive history outcome still resolves an inconclusive realtime finding
- **WHEN** a realtime confirmation query returns a single, correctly-identified row with an
  unrecognized `orderStatus`, and the subsequent order-history query determines the order
  became terminal without ever filling
- **THEN** ABI SHALL classify the package as terminal-without-fill, since history's
  definitive read is still authoritative over realtime's inconclusive one

### Requirement: No failure path returns a fabricated success acknowledgement
Every failure, timeout, or unclassifiable outcome SHALL map to one of the existing public
error responses, never to a success acknowledgement.

#### Scenario: Every non-success outcome maps to a safe error
- **WHEN** any step of applying, confirming, or cancelling a package fails, times out, or
  cannot be classified
- **THEN** ABI SHALL return one of the existing public error responses and SHALL NOT
  return `entry_package_applied` or `entry_package_absent`

#### Scenario: A skipped live execution never produces a success acknowledgement
- **WHEN** the live execution guard reports that a create or cancel command was skipped
  rather than sent to the exchange
- **THEN** ABI SHALL return a safe internal error and SHALL NOT return
  `entry_package_applied` or `entry_package_absent`
