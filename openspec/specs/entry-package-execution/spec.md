# entry-package-execution Specification

## Purpose

Defines the internal application/execution behavior that turns a validated Runtime
desired entry-package command into real, correlated, confirmed Bybit exchange state and a
truthful synchronous acknowledgement or safe failure, replacing today's unconditional
`internal_error` response to every valid request.

## Requirements

### Requirement: ABI applies a new desired entry package by creating a real exchange order
When a valid entry-package command specifies a non-null desired entry and no order
currently exists for that trade cycle, ABI SHALL submit a real create order to the
exchange, bounded-confirm it, and acknowledge `entry_package_applied` only after
confirmation succeeds.

#### Scenario: First application creates a live order
- **WHEN** a PUT request specifies a non-null `desired_entry` for a trade cycle with no
  existing correlation record
- **THEN** ABI SHALL submit a create order to the exchange, bounded-confirm it, and
  return `entry_package_applied` only after confirmation succeeds

#### Scenario: Failed create does not acknowledge success
- **WHEN** the create request is rejected or fails at the transport level
- **THEN** ABI SHALL NOT return `entry_package_applied` and SHALL return a safe error

### Requirement: ABI replaces a live order when the desired entry package changes
When an existing trade cycle has a live or confirmed order and the desired entry changes,
ABI SHALL either amend the existing order in place or replace it via cancel-and-create,
depending on which fields changed, and SHALL confirm the result before acknowledging
success.

#### Scenario: Compatible field change amends the existing order
- **WHEN** price, quantity, stop, or take fields change but side is unchanged
- **THEN** ABI SHALL amend the existing exchange order in place, preserving its order
  identity, and confirm the amendment before acknowledging `entry_package_applied`

#### Scenario: Side change replaces the order via cancel-and-create
- **WHEN** the desired side changes for an existing trade cycle
- **THEN** ABI SHALL cancel the existing order and create a new order under a new
  identity for that trade cycle, confirming the new order before acknowledging
  `entry_package_applied`

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

### Requirement: A changed ticker within an existing trade cycle is rejected without contacting the exchange
The `ticker` associated with a trade cycle is fixed at first application. ABI SHALL
reject any request that supplies a different ticker for the same trade cycle without
making any exchange call.

#### Scenario: Ticker mismatch is rejected without an exchange call
- **WHEN** a PUT request's ticker differs from the ticker already recorded for that
  trade cycle
- **THEN** ABI SHALL return a safe error and SHALL NOT send any request to the exchange

### Requirement: Metadata-only changes update the record without amending or recreating the order
When only `source_plan_bar_open_time_ms` or `locked_exit_profile` differ from the
previously applied desired entry, with side, price, quantity, stop, and take unchanged,
ABI SHALL durably update the stored desired entry and revalidate the existing order
without sending an amend or create request.

#### Scenario: Metadata-only change durably updates without an exchange write
- **WHEN** a PUT request changes only `source_plan_bar_open_time_ms` or
  `locked_exit_profile` relative to the previously applied desired entry
- **THEN** ABI SHALL durably persist the updated desired entry and perform a bounded
  revalidation of the existing order without sending an amend or create request to the
  exchange

### Requirement: Trigger direction is derived deterministically from side, not from market conditions
For the currently supported entry geometry, ABI SHALL derive the exchange trigger
direction solely from the desired entry's `side`, without querying or comparing against
the live market price.

#### Scenario: Long entry maps to a falls-to trigger
- **WHEN** the desired entry's side is `long`
- **THEN** ABI SHALL submit the order with a buy side and a trigger direction that fires
  when price falls to the planned entry level

#### Scenario: Short entry maps to a rises-to trigger
- **WHEN** the desired entry's side is `short`
- **THEN** ABI SHALL submit the order with a sell side and a trigger direction that fires
  when price rises to the planned entry level

#### Scenario: Mapping is stable regardless of the current market price
- **WHEN** the same desired entry is submitted at different times with different
  prevailing market prices
- **THEN** ABI SHALL derive the identical side and trigger direction every time

### Requirement: ABI does not gate order submission on current market price
ABI SHALL NOT compare the current market price against the planned entry price to decide
whether to submit, accept, or reject a create request; acceptance, immediate execution, or
rejection of the request is decided by the exchange, not by ABI.

#### Scenario: Order is submitted regardless of trigger proximity to current price
- **WHEN** the planned entry price is already on the side of the current market price
  that would otherwise trigger the order immediately
- **THEN** ABI SHALL still submit the deterministic create request rather than
  withholding, delaying, or rejecting it locally

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
- **WHEN** a previous create or amend attempt's outcome was never durably confirmed (e.g.
  ABI restarted or lost the response mid-flight), a later identical request arrives, and
  the exchange genuinely has no record of that attempt anywhere
- **THEN** ABI SHALL resend the same command against the exchange, reusing the
  already-reserved order identity, rather than only re-querying indefinitely without ever
  resending

#### Scenario: An attempt is not resent while its true exchange state is merely unclear
- **WHEN** a previous attempt's outcome could not be confirmed, but the inconclusive
  result came from a failed or inconsistent query rather than every query cleanly
  reporting the order absent
- **THEN** ABI SHALL NOT resend the command, since the order may already exist on the
  exchange, and SHALL instead return a safe internal error

#### Scenario: Replacement via cancel-and-create receives a new identity
- **WHEN** ABI replaces an order by cancelling the old one and creating a new one
- **THEN** the new order SHALL receive an identity distinct from every previous order for
  that trade cycle

### Requirement: ABI durably records correlation state before acknowledging success
ABI SHALL durably persist a record of the intended action before contacting the exchange,
and SHALL durably commit the confirmed outcome before returning any success
acknowledgement.

#### Scenario: Provisional record exists before the exchange is contacted
- **WHEN** ABI begins processing a create, replace, or cancel command
- **THEN** ABI SHALL durably persist a record of the intended action before sending any
  request to the exchange

#### Scenario: Success is never acknowledged before durable commit
- **WHEN** ABI is about to return `entry_package_applied` or `entry_package_absent`
- **THEN** ABI SHALL have already durably committed the confirmed state, such that a
  crash immediately before that commit cannot have produced a successful response

### Requirement: ABI confirms package application with field-level accuracy before acknowledging success
After a create or amend is sent, ABI SHALL verify within a bounded window that the
exchange order's actual price, quantity, stop, and take fields match the desired package
before acknowledging success, not merely that an order exists.

#### Scenario: Matching fields confirm the package
- **WHEN** a bounded confirmation query finds the order live with trigger price,
  quantity, stop, and take matching the desired package
- **THEN** ABI SHALL return `entry_package_applied`

#### Scenario: Mismatched fields do not confirm the package
- **WHEN** the exchange-reported order fields do not match the desired package after the
  bounded confirmation window
- **THEN** ABI SHALL NOT return `entry_package_applied`

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
- **THEN** ABI SHALL NOT use that row's fields as evidence the desired package's fields
  match or fail to match, and SHALL treat the query the same as a query failure

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

### Requirement: Early execution observed before acknowledgement still receives a truthful acknowledgement
When the exchange fully or partially fills an order before ABI can respond, ABI SHALL
still acknowledge that the package was applied and SHALL durably record an aggregate
observation of the exchange state at confirmation time.

#### Scenario: Full fill before acknowledgement is still acknowledged
- **WHEN** the order is confirmed fully filled before ABI returns a response
- **THEN** ABI SHALL return `entry_package_applied` and durably record an aggregate
  observation of the exchange state at confirmation time

#### Scenario: Partial fill before acknowledgement is still acknowledged
- **WHEN** the order is confirmed partially filled before ABI returns a response
- **THEN** ABI SHALL return `entry_package_applied` and durably record the aggregate
  observed filled and remaining quantities

#### Scenario: Individual fill history is not reconstructed
- **WHEN** ABI observes cumulative fill state during confirmation
- **THEN** ABI SHALL record only the aggregate observed state, not a reconstructed
  sequence of individual fills

### Requirement: Repeat requests for an already-applied package are truthfully revalidated
ABI SHALL NOT return a cached acknowledgement for a repeated identical request without
revalidating against the exchange; it SHALL classify the current exchange state and
respond truthfully based on that classification.

#### Scenario: Repeat request against a still-live matching order
- **WHEN** the same desired package is submitted again while the previously applied
  order is still live and unchanged
- **THEN** ABI SHALL revalidate against the exchange and return `entry_package_applied`
  without submitting a duplicate create request

#### Scenario: Repeat request discovers a fill
- **WHEN** revalidation discovers the order has been fully or partially filled since it
  was last applied
- **THEN** ABI SHALL return `entry_package_applied` and record the newly observed
  aggregate state

#### Scenario: Repeat request cannot fabricate certainty
- **WHEN** revalidation cannot classify the current exchange state within its bounded
  budget
- **THEN** ABI SHALL return a safe internal error rather than repeating a previous
  acknowledgement

### Requirement: A package that becomes terminal without ever filling is not silently resurrected
When a previously applied order is discovered to have become terminal (rejected,
cancelled, or deactivated outside ABI) without ever having filled, ABI SHALL fail closed
rather than automatically creating a replacement order in the same trade cycle.

#### Scenario: Terminal-without-fill blocks further non-null requests
- **WHEN** a previously applied order is discovered to be terminal without ever having
  filled
- **THEN** ABI SHALL NOT automatically create a replacement order and SHALL return a safe
  internal error for any subsequent non-null `desired_entry` request for that trade cycle

#### Scenario: Explicit cancellation acknowledges the terminal reality
- **WHEN** a request with `desired_entry` null is received for a trade cycle in this
  terminal-without-fill state
- **THEN** ABI SHALL acknowledge `entry_package_absent`, since nothing is live on the
  exchange

#### Scenario: A fresh request after confirmed absence is treated as new intent
- **WHEN** a non-null `desired_entry` request is received for a trade cycle after it has
  been confirmed absent
- **THEN** ABI SHALL treat it as a new application and create a new order, distinct from
  the terminated one

### Requirement: Calculated quantity is genuinely executable on the exchange, not a hardcoded value
ABI SHALL calculate an order quantity that satisfies the exchange's minimum order
quantity, quantity step, and minimum notional value for the traded instrument.

#### Scenario: Minimum quantity satisfies exchange minimum order size
- **WHEN** ABI calculates the quantity for an entry package
- **THEN** the calculated quantity SHALL be at or above the exchange's minimum order
  quantity for that instrument, rounded to its quantity step

#### Scenario: Minimum quantity satisfies exchange minimum notional value
- **WHEN** the exchange's minimum order quantity alone would produce an order value below
  the exchange's minimum notional value for that instrument
- **THEN** ABI SHALL increase the calculated quantity so the resulting order value meets
  the minimum notional value, rounded to the quantity step

#### Scenario: Sizing accepts but does not yet apply risk multiplier
- **WHEN** an entry-package command includes a positive risk multiplier
- **THEN** ABI SHALL accept it and pass it through the sizing calculation without
  rejecting the request, even though the current sizing formula does not yet vary the
  result by that value

#### Scenario: A structurally malformed trading-rules response is never used for sizing
- **WHEN** a `linear`-category `instruments-info` lookup returns a response that is not
  an object, whose `result` is not an object, whose `result.category` does not match the
  requested category, whose `result.list` is not an array, whose `result.list` does not
  contain exactly one row, whose row is not an object, whose row's `symbol` does not
  match the requested symbol, or whose row is missing an object `lotSizeFilter`
- **THEN** ABI SHALL NOT calculate a quantity from that response, SHALL NOT cache it, and
  SHALL return a safe internal error instead of submitting an order

#### Scenario: Trading-rules fields with invalid sign, malformed decimal text, or an unsupported exponent are never used for sizing
- **WHEN** a `linear`-category `instruments-info` lookup's `lotSizeFilter` has a
  `minOrderQty` or `qtyStep` that is not strictly positive exact-decimal text usable by
  ABI's sizing arithmetic (zero, negative, a non-string, malformed text, or text whose
  exponent exceeds the arithmetic parser's supported range), or a `minNotionalValue`
  that is negative, not exact-decimal text, or similarly out of the arithmetic parser's
  supported range
- **THEN** ABI SHALL NOT calculate a quantity from that response, SHALL NOT cache it, and
  SHALL return a safe internal error instead of submitting an order

#### Scenario: A `spot`-category trading-rules lookup is unsupported and fails closed
- **WHEN** ABI requests trading rules for a `spot`-category instrument
- **THEN** ABI SHALL NOT attempt to interpret a `linear`-shaped `lotSizeFilter` from that
  response, SHALL NOT calculate a quantity or cache a result, and SHALL return a safe
  internal error, since `spot`'s trading-rules schema is not supported for sizing in this
  capability

#### Scenario: A zero minimum notional value is a valid trading rule
- **WHEN** an `instruments-info` lookup's `lotSizeFilter.minNotionalValue` is exactly
  `"0"`
- **THEN** ABI SHALL treat this as a valid trading rule and size the order from
  `minOrderQty` alone, unchanged from the existing sizing formula

#### Scenario: A rejected trading-rules response does not poison the cache
- **WHEN** ABI rejects an `instruments-info` response for a given category and symbol as
  malformed or identity-mismatched
- **THEN** ABI SHALL NOT store that response's values in the trading-rules cache, and the
  next lookup for the same category and symbol SHALL query the exchange again rather than
  reuse a prior failed result

### Requirement: Concurrent requests for the same trade cycle are serialized
ABI SHALL process requests for the same trade cycle one at a time, so that concurrent
requests never interleave their exchange calls or correlation writes.

#### Scenario: Duplicate concurrent requests produce one exchange order
- **WHEN** two identical PUT requests for the same trade cycle arrive concurrently
- **THEN** ABI SHALL process them serially such that only one create request reaches the
  exchange

#### Scenario: Conflicting concurrent requests do not interleave
- **WHEN** two different PUT requests for the same trade cycle arrive concurrently
- **THEN** ABI SHALL complete processing of the first before beginning the second, rather
  than interleaving their exchange calls

### Requirement: No failure path returns a fabricated success acknowledgement
Every failure, timeout, or unclassifiable outcome SHALL map to one of the existing public
error responses, never to a success acknowledgement.

#### Scenario: Every non-success outcome maps to a safe error
- **WHEN** any step of applying, replacing, confirming, or cancelling a package fails,
  times out, or cannot be classified
- **THEN** ABI SHALL return one of the existing public error responses and SHALL NOT
  return `entry_package_applied` or `entry_package_absent`

#### Scenario: A skipped live execution never produces a success acknowledgement
- **WHEN** the live execution guard reports that a create, amend, or cancel command was
  skipped rather than sent to the exchange
- **THEN** ABI SHALL return a safe internal error and SHALL NOT return
  `entry_package_applied` or `entry_package_absent`

### Requirement: Startup readiness depends on successful correlation recovery
ABI SHALL NOT accept entry-package execution requests until it has successfully recovered
its correlation state from durable storage at startup.

#### Scenario: Unreadable correlation store blocks readiness
- **WHEN** ABI cannot fully and validly read its correlation store at startup
- **THEN** ABI SHALL report itself not ready and SHALL NOT process entry-package
  execution requests

#### Scenario: Valid store recovery restores current and historical bindings
- **WHEN** ABI restarts with a valid correlation store
- **THEN** ABI SHALL restore the current order binding and its historical bindings for
  every trade cycle before accepting entry-package requests

### Requirement: V1 execution scope is limited to the currently supported entry geometry
The side-to-direction mapping SHALL be documented as scoped to the currently supported
strategy entry geometry, not asserted as a general rule for arbitrary future entry
geometries.

#### Scenario: Unsupported entry geometry is not silently claimed as supported
- **WHEN** this capability's behavior is documented
- **THEN** the documentation SHALL state that the side-to-direction mapping applies to
  the currently supported entry geometry and is not guaranteed for a future, differently
  shaped strategy

### Requirement: Legacy signal and intent endpoints remain unaffected
Implementing this capability SHALL NOT change the observable behavior of the existing
legacy signal and intent endpoints.

#### Scenario: Legacy endpoints behave exactly as before
- **WHEN** this capability is implemented
- **THEN** `POST /signals`, `PUT /intents/:id`, `POST /intents/:id/cancel`, and
  `GET /intents/:id` SHALL continue to behave exactly as they did before this change
