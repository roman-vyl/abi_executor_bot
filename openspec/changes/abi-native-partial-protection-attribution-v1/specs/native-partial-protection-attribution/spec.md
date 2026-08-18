## Purpose

Define how ABI discovers and classifies the Bybit-native protection children (stop-loss and take-profit
legs materialized under `tpslMode: "Partial"`) attached to one trade cycle's own entry order — attributed
exclusively through Bybit's own parent-order linkage, never through side-match, price-match, or timing —
and the fail-closed rules for every outcome other than a clean, uniquely attributed pair. This capability
introduces no new durable state and changes no production-observable behavior on its own; it is the
read-only foundation `abi-native-partial-protection-lifecycle-v1` (replacement/update lifecycle) and
`abi-native-partial-protection-cutover-v1` (production activation) build on.

## ADDED Requirements

### Requirement: Attribution is exclusively through Bybit's own parent-order linkage
ABI SHALL attribute a candidate protection child to a trade cycle's own entry order only by matching a
Bybit-reported parent-order linkage field against that entry order's own `orderLinkId`, and SHALL NOT
attribute a candidate by side, price, timing, or any other plausibility heuristic.

#### Scenario: A candidate whose parent linkage matches is attributed
- **WHEN** ABI resolves attached protection for a trade cycle's own entry `orderLinkId`
- **THEN** ABI considers only candidate orders whose Bybit-reported parent-order linkage equals that
  entry `orderLinkId`
- **AND** ABI does not consider a candidate whose side or price happens to plausibly match but whose
  parent-order linkage does not match or is absent

#### Scenario: A sibling trade cycle's own children are never attributed to this cycle
- **WHEN** more than one trade cycle's own entry orders, and their respective protection children, exist
  for the same `(category, symbol)` scope
- **THEN** resolving attached protection for one trade cycle's own entry `orderLinkId` returns only that
  cycle's own children
- **AND** no candidate whose parent-order linkage names a different entry order is included

### Requirement: A clean result requires exactly one stop-role and one take-role candidate
ABI SHALL classify a trade cycle's attached protection as a valid attributed pair only when exactly one
attributed candidate is classified as the stop-loss role and exactly one is classified as the
take-profit role. ABI SHALL NOT resolve any other combination of attributed candidates by selecting the
"most plausible" one.

#### Scenario: Exactly one stop and one take candidate resolves to an attributed pair
- **WHEN** attribution finds exactly one candidate classified as the stop-loss role and exactly one
  classified as the take-profit role for a trade cycle's own entry order
- **THEN** ABI reports both as the attributed pair
- **AND** ABI does so regardless of either candidate's own current order status

#### Scenario: Only one role present fails closed
- **WHEN** attribution finds a candidate for only one of the two roles (stop or take) and none for the
  other
- **THEN** ABI reports this as ambiguous and does not report a partial result as if it were complete

#### Scenario: More than one candidate for the same role fails closed
- **WHEN** attribution finds more than one candidate classified as the same role for a trade cycle's own
  entry order
- **THEN** ABI reports this as ambiguous and does not select one of them as authoritative

#### Scenario: An unclassifiable candidate fails closed rather than being silently dropped
- **WHEN** attribution finds a candidate attributed to a trade cycle's own entry order whose role cannot
  be classified as either stop-loss or take-profit
- **THEN** ABI reports this as ambiguous
- **AND** ABI does not silently exclude that candidate from consideration when evaluating whether the
  remaining candidates form a clean pair

### Requirement: Attribution covers both live and already-terminal children
ABI SHALL consider both currently live and already-terminal (filled or cancelled) candidate orders when
resolving a trade cycle's attached protection, and SHALL NOT limit attribution to only currently live
orders.

#### Scenario: A terminal child is still attributed
- **WHEN** one of a trade cycle's own attached protection children has already filled or already been
  cancelled by the time ABI resolves attribution
- **THEN** ABI still attributes it to that trade cycle's own entry order if its parent-order linkage
  matches
- **AND** ABI does not require a child to still be live to be considered

### Requirement: No matching candidates is reported plainly, without ABI inferring whether that is expected
ABI SHALL report the absence of any attributed candidate as its own distinct outcome, and SHALL NOT
itself determine whether that absence is expected (for example, because no fill has occurred yet, or
because the entry order was not created with native Partial protection) or contradictory — that
determination belongs to whatever capability calls this one, using facts this capability is not given.

#### Scenario: Zero candidates is reported without an expected/contradictory judgment
- **WHEN** attribution finds no candidate whose parent-order linkage matches a trade cycle's own entry
  `orderLinkId`
- **THEN** ABI reports that no attached protection was found
- **AND** ABI does not itself classify this as either expected or contradictory

### Requirement: This capability introduces no new durable state and changes no production behavior
ABI SHALL resolve attached-protection attribution entirely through fresh, read-only Bybit queries, and
SHALL NOT introduce a new field on the entry-package correlation record, a new durable store, or any
caching of the result. ABI SHALL NOT change `PUT .../entry-package`'s request payload to Bybit, `PUT
.../protection`'s production behavior, or any public HTTP route, request schema, response schema, or
error code as a result of this capability.

#### Scenario: Resolving attribution performs no durable write
- **WHEN** ABI resolves a trade cycle's attached protection
- **THEN** no field on that trade cycle's correlation record, or on any other record, is read for this
  purpose beyond its own entry `orderLinkId`, and none is written as a result

#### Scenario: Entry order creation is unaffected
- **WHEN** ABI creates a new entry order after this capability exists
- **THEN** the request sent to Bybit is identical to what it was before this capability existed,
  including still sending `tpslMode: "Full"`

#### Scenario: Protection command handling is unaffected
- **WHEN** a client calls `PUT .../protection` after this capability exists
- **THEN** ABI's handling of that request — including which guard, if any, applies for a multi-owner
  scope — is identical to what it was before this capability existed
