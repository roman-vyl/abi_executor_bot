## Context

See `proposal.md` for motivation. This change depends on the completed
`abi-physical-position-slot-foundation-v1`: the domain already distinguishes
`InstrumentPositionScope` from `DirectionalPositionSlot`; correlation records durably distinguish
`one_way` from `hedge`; hedge direction is derived from immutable `desired_entry.side`; repository
queries can enumerate an instrument or one directional slot; and the Bybit boundary owns the
`0/1/2` encoder.

The remaining production paths are still deliberately one-way:

- `EntryPackageApplicationService.createOrder()` writes `one_way`, locks the instrument, rejects
  opposite sides, and calls an entry mapper that omits `positionIdx`;
- `decodeOrderQueryResponse()` does not retain or validate an order row's binding;
- `evaluatePositionQueryResponse()` requires exactly one row with `positionIdx = 0`;
- open-position, protection, close, ambiguous-create, and entry-cycle recovery consume that
  one-way position query;
- close dispatch hard-codes `positionIdx = 0`;
- replay reconstructs directional membership but applies an unsupported-mixed-side readiness gate.

Own `orderLinkId`, execution/fill facts, exact protection parent linkage, pair-scoped close identity,
and the append-only correlation record remain the stronger attribution sources. A physical
position row is aggregate sanity, not virtual-owner attribution.

## Goals / Non-Goals

**Goals:**

- Give every internal lifecycle primitive a closed one-way/hedge binding input and fail-closed
  exchange evidence contract.
- Make a controlled explicit hedge record survivable through entry, position resolution,
  protection, close, ambiguity, recovery, and replay tests.
- Preserve the production one-way writer, mapper behavior, admission gate, and readiness gate.
- Prepare read-only account-mode assurance without making current one-way startup depend on Bybit.
- Leave a later activation change with only operational mode assurance wiring, writer selection,
  admission/readiness gate removal, and production smoke.

**Non-Goals:**

- Producing a real hedge record or hedge order from a Runtime request.
- Switching Bybit account, coin, or symbol position mode.
- Weakening own-order/fill attribution or deriving virtual ownership from aggregate positions.
- Changing public contracts, Runtime, Engine, sizing, owner identity, the ownership store,
  multi-account support, or one-cycle-per-instance semantics.

## Decisions

### 1. Resolve one closed internal binding value from each active record

Introduce or centralize a pure binding resolver whose output is either one-way or a
`DirectionalPositionSlot`. It reads `position_binding_mode`, exchange category/symbol, and—for
hedge only—`desired_entry.side`. Hedge remains linear-only. It never accepts a numeric exchange
slot and never consults deployment configuration for an existing generation.

Every lifecycle service derives this value once for the record being handled and passes it to
exchange-facing query/mapping primitives. This avoids each caller independently reconstructing
direction and makes binding mismatch a shared typed failure.

Alternative: pass `positionIdx` through services. Rejected because it makes Bybit encoding a
business identity and permits invalid integers outside the mapper/decoder boundary.

### 2. Keep production creation locked to one-way by construction

The ordinary `createOrder()` provisional construction continues to write explicit `one_way`, and
its production mapper invocation continues to select one-way binding. Hedge-capable mapper and
confirmation branches are exercised through pure/internal inputs and controlled fixtures, not a
Runtime-selectable flag or public DTO.

Tests retain a structural guard proving no ordinary production path supplies hedge geometry and no
Runtime payload can do so. Mixed-side scope classification and the replay policy gate also remain.
Thus an accidentally complete downstream hedge implementation still cannot activate trading.

Alternative: add a disabled environment flag now. Rejected because a mis-set flag would become an
activation path before the separate activation change specifies deployment and smoke gates.

### 3. Make order evidence binding-aware at the decoder boundary

Extend the internal expected-order identity with the expected binding and decode Bybit order rows'
`positionIdx` for entry, close, realtime, and history queries. Linear one-way evidence must report
0; hedge-long must report 1; hedge-short must report 2. A returned exact `orderLinkId` with the
wrong binding is protocol/binding failure, not confirmation.

Entry confirmation, cancellation, terminality, close outcome classification, repeat PUT, and
recovery already share `decodeOrderQueryResponse()` through package-confirmation primitives.
Changing the shared identity contract prevents drift among those paths. Close order exchange side
is validated independently from its binding: a long close is Sell but remains slot 1; a short close
is Buy but remains slot 2.

Spot behavior is not generalized into hedge geometry. Existing supported spot order decoding is
preserved where no derivative position binding is applicable; any hedge record outside linear
fails before exchange access.

Alternative: trust create acknowledgement and only check position rows. Rejected because an
accepted or recovered own order can still contradict the durable slot before a position exists.

### 4. Replace the single-row position primitive with binding-specific decoding

The adapter exposes an internal query in terms of expected binding, not
`queryPositionForInstrument()`'s one-way-only output. The decoder validates the complete response
envelope and then:

- for one-way, preserves the current strict single `positionIdx = 0` contract;
- for hedge, rejects one-way rows, invalid indexes, duplicate rows for the same directional slot,
  symbol/category mismatch, and malformed target evidence;
- returns only the requested directional row or a proven target-flat result;
- treats a valid opposite row as context that is ignored for target exposure and absence.

The exact Bybit response shape for a flat hedge symbol is an evidence checkpoint, not an assumption.
A read-only Demo probe captures the raw shape and a contract test records the admitted cardinality
and omission rules. Until a missing target row is proven to mean flat, the decoder treats it as
inconclusive. This keeps the architecture fixed even if evidence shows one or two flat rows.

Alternative: filter the first row whose side matches the owner. Rejected because side is empty on
flat rows, close orders have the opposite side, and filtering could hide duplicate or unexpected
geometry.

### 5. Position-mode assurance reuses strict position geometry but remains unactivated

Add a read-only internal assurance port/service backed by a symbol-scoped Bybit position read. It
classifies whether the observed geometry is compatible with an internally expected one-way or hedge
policy and returns typed verified/mismatch/unavailable outcomes. It never calls
`/v5/position/switch-mode`.

The later activation will use it in two places:

1. after replay, verify every active scope before readiness;
2. for a previously unseen scope, verify under the instrument admission lock before the durable
   provisional claim.

This change provides the primitive, composition seam, evidence tests, and activation contract, but
does not add an exchange dependency to current one-way startup and does not expose an enabled hedge
configuration. A fresh verification is scoped to one instrument; it cannot authorize another.

Alternative: let ABI switch mode and trust the acknowledgement. Rejected because Bybit mode is an
account/symbol operational mutation with open-order/position preconditions and override precedence;
automatic management expands the service's authority and rollback risk.

### 6. Open-position and ambiguous-create consult only the target binding

`OpenPositionResolutionService.determine()` keeps own fills as the positive attribution truth and
uses the binding-aware position result only for existence/side sanity and target-slot SL/TP fields.
Positive opposite-slot exposure cannot satisfy the target owner.

Ambiguous-create absence keeps its own-order and own-execution prerequisites. Its physical check
is changed from symbol-wide one-way state to the target binding. A same-slot sibling aggregate does
not prove this owner's missing create executed; an opposite-slot row is irrelevant. Unknown target
shape remains tainted/fail-closed.

Alternative: require a flat target slot before declaring an own create absent. Rejected because
same-slot multi-owner exposure can legitimately remain while this owner's exact order and fills are
absent.

### 7. Protection keeps exact-parent attribution and adds binding corroboration

Protection membership re-verification uses the record's directional-slot repository query for
hedge and the instrument query for one-way. It no longer rejects a controlled hedge owner merely
because the opposite slot has active owners.

Native child decoding retains exact `parentOrderLinkId` as ownership and `orderId` as child
identity, then requires both legs to report the expected binding. Desired quantity remains the
owner's own cumulative fill. Amend calls remain by child `orderId`; no aggregate position size,
price, timing, or side heuristic is added.

Alternative: rely on parent linkage alone. Rejected because the readiness requirement is to fail
closed when any exchange evidence contradicts the durable physical binding.

### 8. Close targets the stored slot and keeps pair-scoped recovery identity

Close membership and aggregate sanity become binding-specific. The existing sequence remains:
neutralize own entry remainder; resolve own filled quantity; neutralize exact-parent protection;
check target physical aggregate; durably persist close identity; dispatch; resolve that identity;
verify postconditions; write terminal state.

The close mapper encodes the record's original binding. Its order side is independently the inverse
of entry side. Confirmation and recovery require the close row's same binding plus exact expected
fill quantity. An opposite slot may remain open without blocking terminal closure of this owner.

Alternative: close by side and omit `positionIdx`. Rejected because Bybit requires the slot in
Hedge Mode and close side names the action, not the physical position being reduced.

### 9. Recovery dispatches by durable binding in every restart phase

Entry-cycle recovery resolves the binding before its bounded evidence loop and supplies it to own
entry, position, ambiguous absence, and own close classifiers. Existing own-order-first convergence
policy remains. Target position evidence may veto or corroborate only the target slot.

The test matrix covers: pre-call pending create; accepted/lost response; live unfilled; partial fill;
full fill; protected open; pending/ambiguous close; terminal close; and simultaneous synthetic long
and short records. Binding continuity remains generation plus `order_link_id`; binding-mode
immutability within generation is an additional replay/save invariant already supplied by the
foundation.

Alternative: defer recovery until after entry activation. Rejected because a process can crash
immediately after the first hedge durable write or exchange request.

### 10. Separate replay structure from the retained activation policy

Replay continues to normalize missing binding mode only as legacy provenance, reject active legacy,
and reconstruct current ownership from each pair's latest record. Structural validation recognizes
one-way instrument bindings and independent hedge slots. It separately reports:

- structural corruption or incompatible active one-way/hedge geometry;
- the current policy failure `unsupported_mixed_side_active_state`.

This change retains the policy failure, so synthetic mixed hedge state can prove correct slot
reconstruction in repository tests but cannot make production readiness true. The activation
change will remove only that policy gate after enabling mode assurance and hedge writes.

Inactive legacy, explicit one-way, and hedge history may coexist without rewriting the JSONL log.
Active one-way and hedge geometry for one instrument is never valid merely because virtual sides
match.

### 11. Keep the instrument mutex as the admission boundary

Pair mutex remains outermost. Instrument mutex remains the inner acquisition boundary because a
future hedge admission must inspect legacy/one-way owners and both directional slots atomically.
It encloses future lazy mode assurance, ownership classification, and the durable provisional save;
it is not held across create-order I/O. Different instruments remain independent.

Lifecycle operations continue using the pair mutex. Their own order identities and binding-specific
exchange actions make a broader instrument lock unnecessary. Repository append serialization
remains unchanged.

Alternative: lock only the directional slot. Rejected because two slot locks cannot atomically
exclude an active one-way binding or enforce the retained mixed-side activation gate.

### 12. Public contracts and safety guards do not change

Routes and DTOs remain pair-scoped and slot-free. `positionIdx`, expected geometry, assurance
outcomes, and binding mismatch reasons remain internal. Dry-run behavior, live-enabled checks,
Demo/testnet limitation, and mainnet blocking stay in the existing execution guard. No new public
error code is required; binding contradictions use existing fail-closed internal-error behavior.

## Risks / Trade-offs

- [Flat hedge response cardinality is undocumented or environment-dependent] → Capture read-only
  Demo evidence first, enumerate only proven shapes, and fail closed on every other omission.
- [Generic decoder accidentally relaxes one-way validation] → Preserve the existing one-way branch
  as an exact regression suite and add cross-geometry rejection tests.
- [Internal hedge branch becomes production-reachable] → Keep the provisional writer literal
  `one_way`, retain structural source tests, admission gate, replay gate, and no enabled hedge config.
- [Order identity matches but slot does not] → Decode `positionIdx` in the shared order decoder and
  make mismatch inconclusive for entry, cancel, close, and recovery alike.
- [Opposite slot contaminates target decisions] → Return a target-binding result from the adapter;
  services never receive the opposite row as their position evidence.
- [Protection children omit or inconsistently report binding] → Treat unproven/missing evidence per
  the Demo contract; never weaken exact-parent attribution or act through heuristics.
- [Current one-way startup gains a new network dependency] → Do not wire assurance into production
  readiness until the activation change; test its startup/lazy orchestration through controlled
  seams.
- [Mixed synthetic replay is mistaken for activation] → Keep structural reconstruction and policy
  evaluation separate, with readiness still false for mixed sides.

## Migration Plan

1. Implement and deploy this readiness change with the production activation gate closed. No drain
   or Bybit mode change is required because every new production record and order remains one-way.
2. Run the complete one-way regression suite and controlled hedge lifecycle/restart fixtures.
3. Against an isolated, already operator-configured Bybit Demo hedge symbol with no production
   execution, capture the position-list mode/flat response and lock its admitted shape in a contract
   test. Do not switch mode from ABI and do not place a production hedge order.
4. Restart the readiness build against the existing one-way durable store and verify byte-truthful
   replay and unchanged readiness behavior.
5. This change can roll back to the foundation build because it writes no new production hedge
   records and preserves explicit one-way writes. Internal test fixtures are not deployment state.
6. The later activation change must stop intake, drain active legacy/one-way records, prove no
   relevant Bybit orders or positions remain, switch mode operationally outside ABI, enable and
   require assurance, select hedge for new production records, remove mixed-side gates, and run the
   separately authorized end-to-end Demo smoke. After its first hedge write, rollback is restricted
   to hedge-aware builds.
