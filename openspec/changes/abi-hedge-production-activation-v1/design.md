## Context

See `proposal.md` for motivation. The foundation and lifecycle-readiness changes already provide durable `position_binding_mode`, directional physical bindings, slot-aware exchange evidence, entry/protection/close/recovery mapping, and read-only Bybit mode assurance. Production remains one-way because the last seams are in activation policy and composition:

- `src/config/config.ts` has no deployment-selectable linear binding geometry.
- `EntryPackageApplicationService.createOrder` writes `position_binding_mode: "one_way"`; its entry mapper also receives a separately hard-coded one-way binding.
- `classifyScopeAdmission` classifies desired side but not binding geometry and rejects every opposite-side active owner.
- `replayCorrelationStore` makes readiness true immediately after repository replay and does not invoke `assureReplayedActiveBindings`.
- repository replay reconstructs directional slots but still returns `unsupported_mixed_side_active_state` for any active opposite sides.
- `assureBindingBeforeAdmission` and `assureReplayedActiveBindings` exist as controlled seams but are not composed into production.

The predecessor `abi-hedge-lifecycle-readiness-v1` is currently 37/40. Its tasks 1.1, 1.2, and 3.2 require real flat Hedge Mode evidence and are a release prerequisite, not work to duplicate here.

## Goals / Non-Goals

**Goals:**

- Make explicit hedge geometry reachable through ordinary production composition only when exchange mode and durable state are compatible.
- Keep one durable binding authoritative across entry, restart, protection, close, and recovery.
- Allow both directional slots and same-slot multi-owner without weakening instrument-level admission correctness.
- Preserve safe restart and give operators a reversible boundary before the first hedge write.

**Non-Goals:**

- Redesign any prepared lifecycle, ownership schema, recovery state machine, risk sizing, or public contract.
- Switch Bybit position mode, infer a deployment policy from exchange state, or expose `positionIdx`.
- Activate Hedge Mode for spot or weaken mainnet/live execution guards.
- Execute or substitute for the predecessor's outstanding real-evidence tasks.

## Decisions

### 1. Add one linear-only closed deployment policy with a one-way default

Add an internal configuration value whose parsed domain is `one_way | hedge`, scoped to Bybit linear instruments. Absence selects `one_way`; spot always resolves to one-way. Runtime cannot influence it.

This makes the deployment intent explicit and auditable while preserving current behavior by default. Inferring intent from current exchange rows was rejected: empty position responses can be ambiguous, and observation must not silently choose business geometry. A global all-category hedge flag was rejected because Bybit spot has no hedge slots.

### 2. The provisional durable record is the binding source of truth

For a new linear generation, the service resolves candidate geometry from the deployment policy, completes admission and assurance, then persists it before exchange I/O. After persistence, mapper, confirmation, retry, restart and every prepared lifecycle derive physical binding from that record. The mapper must not independently re-read configuration.

This retains durable-before-exchange and prevents a restart or rollout from remapping an in-flight generation. No second durable slot field is added: for hedge records the slot is derived from immutable desired side, and `positionIdx` remains an exchange encoding.

The existing absent-with-no-history terminal record need not claim a physical slot; it may preserve its current inert one-way provenance. Only a generation capable of producing an exchange binding uses the selected deployment geometry.

### 3. Startup readiness is replay, policy compatibility, then active-scope assurance

Extend correlation access just enough to enumerate active records grouped by instrument after replay. Startup order is:

1. replay and structural validation;
2. validate every active real binding against the configured category policy;
3. call `assureReplayedActiveBindings` for unique active instrument bindings;
4. mark lifecycle readiness true only if every stage succeeds.

Inactive history is excluded from current-mode assurance. Active discriminator-less legacy state continues to require drain. Under hedge policy, an active explicit one-way record blocks readiness rather than being rewritten. Under one-way policy, active hedge state likewise blocks readiness. Assurance unavailable/mismatch is a readiness failure, not a reason to mutate Bybit.

Startup assurance only covers instruments represented by active durable records. It cannot prove an empty, previously unseen instrument and therefore does not replace lazy assurance.

### 4. Fresh assurance occurs inside the instrument admission critical section

Keep the current lock order: pair mutex outside, instrument-scope mutex inside. Inside the instrument lock, admission reads all active owners, validates geometry, performs fresh read-only assurance when the instrument has no active owner, and persists the provisional claim. Exchange create remains outside the instrument mutex.

An active instrument already passed startup assurance or the serialized first-owner assurance in the current process; later owners validate the same durable geometry. When its last owner becomes inactive, the next generation must perform a fresh check. A permanent per-symbol cache was rejected because an externally changed mode after drain could make stale proof unsafe. Slot-only mutexes were rejected because mode and geometry are instrument-wide and opposite first admissions could otherwise race.

### 5. Admission is geometry-aware, not merely side-aware

Replace the production decision's side-only policy with classification over the configured candidate binding and every active instrument record:

- one-way candidate: preserve current same-side multi-owner and reject opposite side;
- hedge candidate: allow existing owners in the same directional slot and the opposite directional slot;
- all modes: reject legacy active state, one-way/hedge mixture, corrupt bindings, category/symbol mismatch, or deployment-policy incompatibility.

Same-slot owners keep pair-scoped identities and independent quantities. The parent instrument remains the serialization boundary even though durable ownership indexes are directional.

### 6. Remove only the retained mixed-side activation gate

Repository replay already builds separate hedge-long and hedge-short memberships. Remove `unsupported_mixed_side_active_state` only for structurally valid explicit hedge records. Retain the active legacy drain gate, active binding-mode mixture rejection, duplicate-pair checks, one-way side consistency, immutable binding checks, and slot-index validation.

No new recovery state machine is needed. After replay/policy/mode gates pass, the prepared lifecycle follows each record's durable binding and own order/execution attribution.

### 7. ABI assures mode read-only and never owns switching

Wire the existing position-mode assurance through startup and first admission. It uses authenticated position evidence and fails closed on transport errors, malformed/unproven shape, or mismatch. ABI exposes no mode mutation call and never invokes Bybit switch-mode.

The new configuration describes expected execution geometry; it is not proof that Bybit is configured correctly. That proof remains a separate runtime gate.

### 8. Activation is one atomic release boundary

The configuration parser/composition, startup gate, lazy assurance, durable writer, binding-aware admission, and mixed-hedge replay policy must ship together. Enabling a hedge writer before protection/close/recovery would be unsafe, but those paths are already prepared by the predecessor and must pass its remaining real evidence before this activation can be enabled.

Public HTTP contracts, Strategy Runtime, Strategy Engine, risk sizing, existing live guard, and exchange-private `positionIdx` mapping do not change.

## Restart and intermediate lifecycle behavior

On restart, a pending-create, ambiguous-create, live entry, partial/full fill, protected position, pending/ambiguous close, or terminal explicit hedge record is first structurally replayed, checked against deployment policy, and assured against actual mode. Only then can readiness expose lifecycle routes. Existing recovery uses the record's durable binding; an opposite slot is neither borrowed nor treated as target evidence.

A crash after provisional persistence but before create therefore recovers the same hedge slot. A crash after exchange acceptance uses the same order identity and slot-aware ambiguous-create evidence. A crash during protection or close uses the already prepared target binding. A mixed long/short hedge restart is valid only when all structural and assurance gates pass.

## Risks / Trade-offs

- [Bybit evidence cannot prove mode for a new flat instrument] → Require accepted predecessor real-flat evidence and fresh read-only assurance; block rather than guess when response geometry is unproven.
- [External mode changes after readiness] → Re-assure every transition from zero active owners; operationally prohibit mode changes while ABI admission is running.
- [A rollout configuration change conflicts with active records] → Treat compatibility as a startup readiness gate; never rewrite durable bindings.
- [Assurance adds exchange availability to hedge startup/first admission] → Fail closed; current default one-way behavior remains available until operators deliberately activate hedge policy.
- [Rollback binary no longer understands durable hedge records] → After first hedge record, allow only hedge-aware builds and require full drain before returning to one-way mode.
- [Same-slot aggregate positions remain shared] → Preserve own order/fill attribution and existing same-side multi-owner semantics; aggregate slot evidence remains only the lifecycle-specific sanity check already designed.

## Migration Plan

1. Complete and accept `abi-hedge-lifecycle-readiness-v1` tasks 1.1, 1.2, and 3.2 using real flat Bybit Hedge Mode evidence; run its full validation gates.
2. Implement this activation while leaving the new policy at its one-way default; run unit, integration/restart, typecheck, lint/build, and strict OpenSpec validation.
3. Stop new admission and drain every active discriminator-less legacy and explicit one-way binding on the target account/instruments.
4. Verify all relevant ABI-owned entry/protection/close orders and physical positions are flat. Preserve durable history; do not rewrite it as hedge.
5. Switch Bybit linear position mode outside ABI through an operator-controlled procedure.
6. Deploy a hedge-aware build with hedge policy selected. Startup replay, policy compatibility, and active-scope assurance must succeed before readiness.
7. For the first inactive instrument, require lazy assurance before the durable claim. Perform controlled Demo/testnet smoke and verify both slots, protection, close, restart and recovery before wider admission.

Rollback before the first hedge durable write restores the prior one-way deployment only after confirming no exchange write occurred and restoring externally compatible mode. After the first hedge write, keep a hedge-aware binary; stop admission, allow/recover or manually resolve all hedge-bound lifecycle state, drain orders and exposure, verify flatness, switch Bybit externally to one-way, and only then start with one-way policy and successful assurance.
