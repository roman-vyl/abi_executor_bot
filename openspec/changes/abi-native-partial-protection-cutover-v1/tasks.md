## 1. Canonical Partial Entry Mapping

- [ ] 1.1 Change `mapEntryPackageToBybit()` so every canonical live entry payload carries
  `tpslMode: "Partial"` with the existing attached Market stop/take fields, preserving exact strings,
  trigger-direction mapping, `positionIdx`, and stable entry identity.
- [ ] 1.2 Fold the Partial payload tests into the canonical mapper suite, cover long and short entries,
  and remove `buildPartialProtectionEntryOrderPayload()` plus every production/test reference to the
  parallel builder.
- [ ] 1.3 Add a structural regression assertion that production entry mapping contains no `Full` mode
  or owner-count-dependent mapper selection.

## 2. Native Protection as the Only Production Path

- [ ] 2.1 Refactor `ProtectionApplicationService` so its existing public `apply()`/`process()` validation,
  per-pair locking, durable-absence handling, active-membership checks, and live guard feed the native
  Partial desired-state/reconciliation pipeline without nested mutex acquisition.
- [ ] 2.2 Remove the shared-owner rejection and map native reconciliation outcomes to the existing closed
  public success/error contract; permit both sole owners and valid same-side shared owners through the
  identical lifecycle.
- [ ] 2.3 Delete the legacy position-level protection read/write flow and all production calls to
  `executeProtectionUpdate()`/`setTradingStop()`; remove the adapter/execution primitive and fake support
  if repository-wide reference search confirms no remaining consumer.
- [ ] 2.4 Replace legacy protection tests with focused native-path tests for already-satisfied state,
  explicit take, null-take surrogate, trigger-only amend, quantity synchronization, fresh post-amend
  read-back, typed dependency failure, terminal/ambiguous children, and skipped live execution.
- [ ] 2.5 Add identical owner-count-one and owner-count-many protection cases proving only exact
  `parentOrderLinkId`-attributed child IDs are observed/amended and every sibling child remains unchanged.

## 3. Pair-Scoped Close for Every Owner Count

- [ ] 3.1 Remove the single-owner raw aggregate `row.size` close branch and route every active cycle
  through the existing exact-own fill resolution, stable current-generation close identity, durable-before-
  dispatch, and exact close-order recovery flow.
- [ ] 3.2 Generalize prior-close lookup and resend suppression to every owner count, preserving same-identity
  recovery and fail-closed live/ambiguous outcomes across create exceptions and confirmation timeouts.
- [ ] 3.3 Validate aggregate position only as a sanity/veto observation: accept flat or matching-side
  evidence when consistent with own exposure, and fail closed on query/decode failure, opposite-side state,
  or aggregate quantity smaller than positive own exposure; never source close quantity or success from it.
- [ ] 3.4 Implement bounded exact-child cleanup using `resolveOwnAttachedProtection()`: cancel an active
  attributed child by exact `orderId`, re-resolve after each ACK to respect pair-coupled deactivation, and
  require both own legs inactive/terminal before terminalization.
- [ ] 3.5 Make the final `terminal_closed` gate require exact entry neutralization, exact own close execution
  for positive exposure (or clean zero own exposure), and verified own-child inactivity, while allowing a
  same-side sibling to keep aggregate position and its own orders active.
- [ ] 3.6 Add close tests for sole-owner and shared-owner positive exposure, clean zero own exposure,
  aggregate contradictions, exact/partial/zero close execution, never-created resend, ambiguous prior
  close, pair-coupled child cancel, terminal child read-back, duplicate/ambiguous attribution, and every
  durable/write crash boundary.
- [ ] 3.7 Add sibling-isolation assertions proving close never submits a sibling entry/child `orderId`, never
  uses cancel-all/symbol-wide cancellation, never changes sibling correlation, and never includes sibling
  exposure in quantity.

## 4. Activate Side-Aware Same-Side Admission

- [ ] 4.1 Remove the temporary production guard around `classifyScopeAdmission()` so `empty` and
  `same_side` proceed while `opposite_side` and `corrupt` fail before any exchange write, with the existing
  atomic durable-claim ordering preserved.
- [ ] 4.2 Extend service-level admission tests for a first owner, sequential and concurrent same-side join,
  same-pair retry with siblings, opposite-side rejection, corrupt/missing-side rejection, exact one-winner
  behavior where appropriate, and restart replay of multiple same-side owners.
- [ ] 4.3 Add an end-to-end service composition test proving two genuine same-side entry-package PUT flows
  both create canonical Partial entries and remain independently active; ensure no test-only repository
  seeding is used to establish the second owner.

## 5. Public Contract and Dead-Path Removal

- [ ] 5.1 Remove `shared_scope_protection_unsupported` from domain unions, result helpers, route mapping,
  OpenAPI, fakes, and tests while leaving all remaining protection/close request and response DTOs unchanged.
- [ ] 5.2 Update public contract tests so a valid same-side shared-scope protection request follows the normal
  native lifecycle and exchange ambiguity remains a secret-safe `internal_error`.
- [ ] 5.3 Run repository-wide forbidden-path checks and remove dead comments/helpers/imports for legacy
  `tpslMode: "Full"`, position-level `setTradingStop`, owner-count protection rejection, raw aggregate close
  quantity, and the proof-only reconciliation entry point; retain no callable fallback or feature flag.

## 6. Cross-Capability Safety Verification

- [ ] 6.1 Add an integration matrix covering single owner and two same-side owners from entry creation through
  protection reconciliation and close-one terminalization, asserting exact identities, quantities,
  attribution, durable ordering, and untouched sibling state at every step.
- [ ] 6.2 Add negative integration cases for opposite-side/corrupt admission, non-attributed/duplicate native
  children, malformed or failed exchange queries, guard-skipped mutations, and aggregate/own-evidence
  contradictions, proving no fabricated `2xx` and no legacy fallback.
- [ ] 6.3 Verify existing ambiguous-create recovery, entry-package retry/idempotency, correlation replay,
  position lookup, dry-run behavior, demo/testnet execution gates, and mainnet live blocking remain green.
- [ ] 6.4 Run `npm test`, `npm run typecheck`, the repository's OpenAPI/contract verification, and
  `openspec validate abi-native-partial-protection-cutover-v1 --strict`; record and resolve every failure
  causally introduced by the cutover.

## 7. Rollout Acceptance and Evidence

- [ ] 7.1 Record the pre-cutover rollback commit and deploy only the completed single-path revision; do not
  deploy an intermediate state that admits same-side sharing before native protection and pair-scoped close
  are the only paths.
- [ ] 7.2 Apply the separately approved Runtime→Engine timeout override operationally without changing ABI or
  treating it as a Change 8 code task; verify Runtime, Engine, and ABI health before trading smoke.
- [ ] 7.3 On Bybit Demo only, prove a sole owner uses canonical Partial entry, attributable native protection,
  and pair-scoped close with no legacy call; clean up only exact smoke entities and stop on any ambiguity.
- [ ] 7.4 In a separate Bybit Demo phase, prove two same-side cycles coexist with independent entries and
  protection, then close one and verify the sibling's exposure, entry state, child IDs, and correlation are
  unchanged; separately prove opposite-side admission is rejected before an exchange write.
- [ ] 7.5 Report recovery acceptance separately from the next genuine-bar pipeline acceptance, preserve
  `PAIR/OCO BINDING AFTER AMEND: NOT PROVEN`, confirm no experimental orders/positions remain, and stop the
  rollout on any failed invariant rather than enabling a fallback.
