## MODIFIED Requirements

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
