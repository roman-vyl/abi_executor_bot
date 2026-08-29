## 1. Activation prerequisites

- [ ] 1.1 Verify `abi-hedge-lifecycle-readiness-v1` tasks 1.1, 1.2, and 3.2 are completed with accepted real flat Bybit Hedge Mode evidence; do not enable or smoke production hedge writes if any remains incomplete.
- [ ] 1.2 Re-run the predecessor change's required tests and strict validation after its evidence fixtures are finalized, and record the passing prerequisite in the activation handoff.
- [ ] 1.3 Confirm the implementation baseline contains the complete slot-aware entry, open-position, protection, close, recovery, restart, and read-only mode-assurance behavior specified by the predecessor.

## 2. Deployment policy and composition

- [ ] 2.1 Add a closed linear position-binding policy type and config parser accepting only `one_way | hedge`, defaulting to `one_way`, with focused valid/default/invalid configuration tests.
- [ ] 2.2 Resolve effective new-binding geometry by instrument category so linear follows deployment policy and spot remains one-way, with unit tests.
- [ ] 2.3 Wire the parsed policy and existing mode-assurance dependencies through the production composition root without adding any Runtime/public API selector.
- [ ] 2.4 Verify no Bybit switch-mode operation is added or called and that `positionIdx` remains confined to exchange mapping/evidence types.

## 3. Active-state queries and replay policy

- [ ] 3.1 Add the minimal repository read primitive needed to enumerate all active correlation records or active bindings after replay without creating a second ownership store.
- [ ] 3.2 Test active enumeration across explicit one-way, explicit hedge, inactive history, and discriminator-less legacy records.
- [ ] 3.3 Remove the retained `unsupported_mixed_side_active_state` gate for structurally valid explicit hedge-long plus hedge-short owners while preserving directional index reconstruction.
- [ ] 3.4 Keep replay fail-closed for active legacy records, one-way opposite sides, one-way/hedge mixtures, binding corruption, duplicate pair conflicts, and incompatible immutable geometry; add focused regression tests.

## 4. Binding-aware admission and durable entry activation

- [ ] 4.1 Replace side-only admission classification with a binding-aware decision over deployment policy and every active owner of the instrument.
- [ ] 4.2 Preserve one-way same-side admission, allow same-slot hedge multi-owner and opposite hedge slots, and reject legacy/mixed/corrupt/incompatible states in focused admission tests.
- [ ] 4.3 Keep pair mutex outermost and instrument mutex around active lookup, classification, any required assurance, and the durable claim; add concurrent same-instrument opposite-side and different-instrument tests.
- [ ] 4.4 Select effective geometry for a new exchange-capable generation and persist it in the provisional record before exchange I/O; leave inert absent-with-no-history records non-owning.
- [ ] 4.5 Derive entry create/confirmation binding from the persisted provisional record instead of a second hard-coded or config-derived value, with crash/retry/config-change regression tests.
- [ ] 4.6 Prove failed mode assurance writes no provisional record, sends no create, and releases no ownership that was never acquired.

## 5. Startup and lazy position-mode gates

- [ ] 5.1 Extend startup orchestration to run replay, configured-policy compatibility checks, and active-binding read-only assurance before marking lifecycle readiness true.
- [ ] 5.2 Keep readiness false with actionable fail-closed reasons for replay failure, active legacy/incompatible geometry, assurance mismatch, unavailable evidence, and malformed evidence.
- [ ] 5.3 Under the instrument admission lock, invoke fresh read-only assurance before the first owner of an inactive hedge-policy instrument is durably claimed.
- [ ] 5.4 Reuse the current-process assurance implicit in an active compatible owner, but require fresh evidence again after the last owner drains; add lifecycle tests for both cases.
- [ ] 5.5 Verify inactive one-way/legacy history is preserved without being assured or reinterpreted and does not alone block hedge readiness.

## 6. Restart and end-to-end safety tests

- [ ] 6.1 Add startup tests for matching/mismatching configured policy and exchange geometry with zero, one, and both active hedge slots.
- [ ] 6.2 Add restart tests for simultaneous long/short owners across pending create, accepted-create ambiguity, live/filled entry, protected exposure, pending/ambiguous close, and terminal convergence using each record's durable binding.
- [ ] 6.3 Add end-to-end application tests proving independent strategy instances can open opposite slots and same-slot siblings retain independent attribution.
- [ ] 6.4 Add regression tests proving dry-run behavior, demo/testnet live guard, mainnet block, durable-before-exchange ordering, idempotent identity, and existing public response shapes are unchanged.

## 7. Operations, validation, and release gate

- [ ] 7.1 Document the stop-admission, drain active legacy/one-way bindings, order/position flatness verification, external Bybit mode switch, startup verification, and staged Demo/testnet activation procedure.
- [ ] 7.2 Document rollback before and after the first durable hedge record, including the hedge-aware-build requirement and full drain before returning to one-way policy.
- [ ] 7.3 Run the complete test suite, typecheck, lint/build or repository-equivalent quality gates, and fix all failures without weakening safety assertions.
- [ ] 7.4 Run strict OpenSpec validation and `git diff --check`, and verify public contracts, Strategy Runtime/Engine, risk sizing, and unrelated production behavior were not changed.
- [ ] 7.5 Before the first real hedge write, execute the documented readiness checklist and confirm the predecessor evidence prerequisite, flat account state, external Hedge Mode, successful ABI assurance, guard settings, and cleanup plan.
