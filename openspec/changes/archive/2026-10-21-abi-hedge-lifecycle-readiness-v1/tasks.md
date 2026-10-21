## 1. Evidence and Contract Baseline

- [x] 1.1 Capture a read-only `/v5/position/list` response for an operator-preconfigured, flat Bybit Demo hedge-mode linear symbol without switching mode or placing an order, and record the exact cardinality, indexes, and flat-row fields as repository evidence.
- [x] 1.2 Turn the captured flat hedge response into a deterministic contract fixture and document which response shapes are proven admissible versus fail-closed.
- [x] 1.3 Extend public-contract structural tests to keep `positionIdx`, directional-slot encodings, binding mode, and assurance policy absent from every Runtime-facing entry, open-position, protection, close, and recovery schema.

## 2. Shared Binding and Order Evidence

- [x] 2.1 Add a pure internal resolver from an active correlation record to exactly one one-way or directional hedge binding, deriving hedge direction only from immutable `desired_entry.side` and rejecting non-linear or incomplete hedge records.
- [x] 2.2 Extend internal entry-order mapping to accept explicit binding geometry and use the foundation `encodeBybitPositionIdx()` mapping while preserving the ordinary production mapper call as one-way.
- [x] 2.3 Extend the shared expected-order identity and order-response decoder to validate binding-compatible `positionIdx` for linear entry and close rows without leaking the numeric value into domain or public contracts.
- [x] 2.4 Thread expected binding through entry confirmation, cancellation confirmation, terminality, own-close classification, and their realtime/history retry paths.
- [x] 2.5 Add exhaustive order-evidence tests for one-way, hedge-long, hedge-short, missing/invalid index, cross-geometry mismatch, opposite-slot mismatch, and close-side-versus-slot independence.

## 3. Binding-Aware Position Query and Mode Assurance

- [x] 3.1 Replace the one-way-only internal position result with a binding-aware target-position result that represents target exposure, proven target flatness, and typed fail-closed reasons.
- [x] 3.2 Implement strict one-way decoding as a regression-preserving branch and hedge decoding from the Demo contract fixture, rejecting malformed envelopes, unexpected indexes, duplicate target slots, and every unproven missing-row shape.
- [x] 3.3 Ensure the hedge decoder selects only the expected directional slot and never returns opposite-slot size, side, average price, stop-loss, or take-profit as target evidence.
- [x] 3.4 Add a read-only position-mode assurance primitive that accepts one explicit internal one-way-or-hedge expectation and returns verified, mismatch, or unavailable for one instrument, with no deployment policy and no dependency on the Bybit switch-mode endpoint.
- [x] 3.5 Add controlled startup and lazy-assurance orchestration seams for the later activation while proving that current one-way startup readiness and production admission do not call them.
- [x] 3.6 Add focused decoder and assurance tests for flat/live one-way and hedge shapes, mixed responses, mode mismatch, transport failure, malformed evidence, and per-instrument isolation.

## 4. Entry and Open-Position Lifecycle

- [x] 4.1 Thread the durable record binding through repeat create, post-create confirmation, cancel, and retry paths so one generation can never change geometry after ambiguity or restart.
- [x] 4.2 Make ambiguous-create absence consult only target-binding position evidence while retaining own-order, own-execution, evidence-window, and same-slot sibling semantics.
- [x] 4.3 Make open-position determination query the stored binding, retain own fills as attribution truth, and source aggregate sanity plus confirmed protection values only from the target slot.
- [x] 4.4 Add controlled hedge entry/open-position tests for lost create response, unfilled, partial fill, full fill, same-slot sibling, opposite-slot-only exposure, slot mismatch, and unchanged one-way behavior.

## 5. Native Protection Lifecycle

- [x] 5.1 Decode and validate protection-child binding evidence after exact parent linkage and role classification, failing closed when either attributed child contradicts the owner binding.
- [x] 5.2 Re-verify active ownership at instrument level for one-way records and directional-slot level for hedge records without treating an opposite hedge owner as loss of target membership.
- [x] 5.3 Preserve own-fill desired quantity, exact-parent child selection, orderId-based amend, and sibling isolation while threading expected binding through reconciliation and read-back.
- [x] 5.4 Add protection tests for hedge-long/short, mixed synthetic slots, same-slot siblings, mismatched child slot, missing/unproven binding evidence, and one-way regression behavior.

## 6. Pair-Scoped Close Lifecycle

- [x] 6.1 Make close ownership and aggregate sanity operate on the record's one-way or directional binding and ignore opposite-slot exposure.
- [x] 6.2 Build close payloads with exchange side opposite the entry while encoding the original record binding, preserving durable close identity before any exchange write.
- [x] 6.3 Require entry neutralization, protection neutralization, close confirmation, resend, and postconditions to retain the same expected binding and own quantity.
- [x] 6.4 Add close tests for hedge-long Sell/slot-long, hedge-short Buy/slot-short, same-slot multi-owner quantity, opposite slot remaining open, mismatched close evidence, ambiguous response, restart/resend, and unchanged one-way behavior.

## 7. Recovery, Replay, and Restart

- [x] 7.1 Thread the durable binding through entry-cycle recovery's own entry, target-position, ambiguous-absence, own-close, and convergence evidence without weakening generation/order identity continuity.
- [x] 7.2 Add restart tests for pending create before exchange call, accepted create with response lost, live unfilled entry, partial fill, full fill, and protected open hedge exposure.
- [x] 7.3 Add restart tests for durable pending/ambiguous close, matched close, zero/partial close outcomes, terminal close, and opposite-slot continuity.
- [x] 7.4 Separate replay structural validation from the retained unsupported-mixed-side production policy while continuing to fail active legacy, malformed hedge, binding-mode mutation, and active one-way/hedge mixtures closed.
- [x] 7.5 Add replay tests for inactive legacy and explicit one-way history, inactive mixed-era history, active explicit one-way, same-slot hedge siblings, simultaneous synthetic long/short slot reconstruction with readiness blocked, and independent owner release.

## 8. Activation Boundary and Concurrency Guards

- [x] 8.1 Retain the literal production provisional `position_binding_mode = "one_way"`, ordinary one-way entry mapping, and absence of any Runtime-selectable, deployment-selectable, or enabled hedge policy.
- [x] 8.2 Retain instrument-scoped admission serialization and the current mixed-side classifier rejection, proving pair-lock-then-instrument-lock ordering, same-side multi-owner admission, opposite-side rejection, and different-instrument independence.
- [x] 8.3 Retain the mixed-side replay/readiness activation gate and add structural tests proving no production entry, recovery, or assurance seam can bypass it after this change.
- [x] 8.4 Document the later activation sequence: intake stop, legacy/one-way drain, no-order/no-position proof, external Bybit mode switch, required startup/lazy assurance, hedge writer selection, mixed-side gate removal, Demo end-to-end smoke, and hedge-aware rollback floor.

## 9. Quality Gates

- [x] 9.1 Run the full unit and integration test suite with `npm test`.
- [x] 9.2 Run TypeScript validation with `npm run typecheck` and the production build with `npm run build`.
- [x] 9.3 Run OpenAPI validation and confirm every existing public contract remains byte/shape compatible and slot-number free.
- [x] 9.4 Run `openspec validate abi-hedge-lifecycle-readiness-v1 --strict`.
- [x] 9.5 Run `git diff --check` and confirm the implementation contains no production Hedge Mode smoke, no automatic mode switching, and no unrelated changes.
