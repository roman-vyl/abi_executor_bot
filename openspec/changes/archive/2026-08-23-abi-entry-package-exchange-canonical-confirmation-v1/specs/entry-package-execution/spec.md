## MODIFIED Requirements

### Requirement: ABI confirms package application with field-level accuracy before acknowledging success
After the exchange accepts a create or amend, and when ABI revalidates the same binding
for a repeat PUT or metadata-only update, ABI SHALL verify within a bounded window that
the read-back identifies the expected `category`, `symbol`, and `orderLinkId`, reports a
recognized live or filled state, carries the expected quantity, and contains structurally
valid exchange-reported numeric fields. The exchange-reported `triggerPrice`, `stopLoss`,
and `takeProfit` SHALL be treated as the authoritative exchange representation and SHALL
NOT be required to equal the raw desired-entry decimal text.

#### Scenario: Exchange-canonical prices do not create false ambiguity
- **WHEN** a successful create or amend is read back for the same correctly identified
  order with the expected quantity and a recognized state, but Bybit represents
  `triggerPrice`, `stopLoss`, or `takeProfit` with decimal text different from the raw
  desired-entry text
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
