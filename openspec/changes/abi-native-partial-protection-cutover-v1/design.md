## Context

See `proposal.md` for the activation rationale. The branch already contains the preparatory pieces:

- `classifyScopeAdmission()` and multi-owner-aware correlation lookup from Change 5, wrapped by a
  temporary production guard that still rejects `same_side`;
- exact native child attribution through `parentOrderLinkId` from Change 6;
- an in-place native Partial reconciler, own-fill quantity resolution, dormant-take surrogate, and
  fresh read-back rules from Change 7, exposed beside rather than inside production `apply()`;
- the pair-scoped close identity and own-execution recovery algorithm from Change 2, currently selected
  only when `activeRecords.length > 1`;
- a canonical entry mapper that still emits `tpslMode: "Full"` plus a separate proof-only Partial
  payload builder.

Bybit Demo evidence establishes that attached Partial children are attributable, amendable in place,
and cancel-coupled as one pair. The evidence does not prove TP/SL OCO behavior after both children have
been amended. This design therefore depends only on observable active-state/read-back and exact-order
cancel behavior, not on an unobserved future OCO trigger.

The change is intentionally destructive. There is no runtime switch and no coexistence period: rollback
uses the pre-cutover Git commit/branch boundary.

## Goals / Non-Goals

**Goals:**

- make one canonical Partial entry mapping, one native protection lifecycle, one pair-scoped close
  lifecycle, and one side-aware admission policy production-reachable;
- preserve exact pair identity, durable ordering, bounded confirmation, live guards, and fail-closed
  exchange decoding while removing owner-count behavior routing;
- make single-owner tests prove the new path rather than merely retaining previous output shapes;
- prove that closing or protecting one cycle cannot mutate a same-side sibling.

**Non-Goals:**

- no Runtime, Engine, MDS, public route, request DTO, correlation schema, or master-plan change;
- no feature flags, legacy aliases, dual writes, rollback adapter, or compatibility mode;
- no ABI-managed OCO implementation, multi-fill research, partial close, hedge mode, opposite-side
  coexistence, durable protection generations, or retry-policy redesign;
- no operational timeout edits; the planned external Runtime→Engine timeout override remains a rollout
  action after apply, not an ABI code path.

## Decisions

### 1. Replace mapper semantics in place; delete the sibling Partial builder

`mapEntryPackageToBybit()` remains the single entry-package mapping boundary and changes its canonical
create payload from `Full` to `Partial`. The proof-only `buildPartialProtectionEntryOrderPayload()` is
removed after its semantics and tests are folded into the canonical mapper. Every create call site keeps
calling the same mapper; owner count never reaches mapping as an input.

This avoids a cutover flag and prevents future call sites from accidentally selecting legacy `Full`.
Keeping two builders and switching in the service was rejected because it makes destructive activation
reversible at runtime and preserves the semantic split this change exists to eliminate.

Mapper/contract tests cover long and short trigger direction, exact price strings, Market TP/SL,
`positionIdx`, stable `orderLinkId`, and `tpslMode: "Partial"`. A structural test rejects production
references to the removed builder and any `tpslMode: "Full"` entry fixture.

### 2. Admission consumes the existing four-way classifier directly

Entry create retains the per-scope atomic admission boundary and durable-before-exchange ordering. The
temporary wrapper that collapses `same_side` into conflict is deleted. The production decision is:

| Classification | Result |
|---|---|
| `empty` | admit |
| `same_side` | admit |
| `opposite_side` | fail closed before exchange write |
| `corrupt` | fail closed before exchange write |

The classifier already excludes the requesting pair, so same-pair retries continue without
self-conflict. No new ownership store is added; replay continues deriving active membership from each
pair's latest correlation record. The existing replay rule already permits multiple same-side final
records and rejects mixed-side/corrupt final state.

Alternative owner-count routing was rejected: `count === 1` is not an ownership guarantee under a race
and would reintroduce different lifecycle semantics for the first owner.

### 3. Production protection delegates to the existing native reconciler

`ProtectionApplicationService.apply()`/`process()` keeps public validation, pair locking, durable-absence
handling, and ownership membership checks, then delegates to the native desired-state/reconciliation
pipeline already exposed by `reconcileNativePartial()`. The public and proof-only entry points are
collapsed so there is one locked production implementation, not one method calling another public method
and reacquiring the same keyed mutex.

The `activeRecords.length > 1` rejection is removed. Membership and side consistency remain defensive
preconditions, but no owner-count branch chooses behavior. The old position-level state reader,
`executeProtectionUpdate()`/`setTradingStop()` production call, and their tests/fake-call expectations are
deleted when they have no remaining consumer. The adapter primitive is removed as well if repository-wide
reference search confirms it is unused; it must not remain as an alternate production route.

Typed reconciliation outcomes map to the existing public closed result/error envelope. Success is mapped
only from `already_satisfied` or a freshly confirmed reconciled own pair. `no_attributed_pair`, ambiguity,
missing own quantity, amend rejection, stale/terminal child, trading-rule failure, and failed read-back all
remain fail-closed and cannot be converted into a position-level fallback.

For `take_price = null`, production uses the Change 7 dormant surrogate and keeps both native children.
The stop-only/cancel-one-leg behavior is not used because Demo showed exact cancellation deactivates the
pair.

### 4. Attribution is the mandatory ownership boundary, not a persistence boundary

Protection and close pass the cycle's stored current entry `orderLinkId` into
`resolveOwnAttachedProtection()` and act only on a clean exactly-one-stop/one-take result. The resolver
stays fresh, read-only, deduplicated by child `orderId`, and fail-closed across realtime/history evidence.
No child identity is copied into the correlation record and no price/side/time heuristic is introduced.

This makes attribution production-critical without giving it policy: protection decides whether an
attributed pair satisfies desired state; close decides whether its attributed children are inactive.
`none` is interpreted by those callers using their own fill/lifecycle facts, never by the resolver itself.

### 5. Collapse close onto the existing pair-scoped algorithm for all owner counts

The `activeRecords.length > 1` branch and the legacy single-owner block based on `row.size` are replaced by
one flow. After exact entry neutralization, every cycle:

1. resolves its own filled exposure from exact current-generation entry order/execution evidence;
2. performs a validated aggregate position read only as sanity/veto evidence;
3. records/reuses its deterministic current-generation close identity before dispatch;
4. dispatches a reduce-only Market close for exact own exposure, if positive;
5. proves exact execution through that close identity;
6. deactivates and freshly verifies only its attributable native Partial children;
7. writes `terminal_closed` only after all own postconditions pass.

The aggregate read permits flat or same-side state, rejects opposite-side/malformed/failed evidence, and
rejects an aggregate smaller than the resolved own quantity. It never supplies quantity or completion
proof. A flat aggregate with positive unresolved own exposure is contradictory and therefore cannot
authorize a reduce-only dispatch or terminal success.

The existing stable-identity recovery path is generalized by removing its multi-owner precondition, not
duplicated. A clean zero own exposure takes no close identity and no close write, but still neutralizes the
entry and verifies attributable-child cleanup before terminalization.

Retaining the raw aggregate path for a sole owner was rejected because "sole active ABI record" does not
prove the account aggregate contains only that record's exposure; it also makes first-owner behavior
change when a sibling joins.

### 6. Native child cleanup is bounded, exact, and pair-aware

Close starts from a fresh clean attribution result. For any active own child, it sends an exact
`orderId` cancel under the existing live guard, then re-resolves the complete pair. Because Bybit Demo
showed that cancelling one attached child deactivates its sibling, the loop does not blindly cancel both
IDs from a stale snapshot. It re-reads after each accepted cancel; if another exact own child remains
active, it may cancel that freshly observed identity within the bounded budget. Success requires both
attributed children inactive/terminal, or a caller-justified clean absence consistent with fresh terminal
entry/execution evidence. Ambiguity, duplicate roles, identity drift, or an unconfirmed active child fails
closed.

No account-wide/symbol-wide cancel is allowed. A same-side sibling's different `parentOrderLinkId` is
excluded before planning any write. Cleanup is serialized only by the requested pair's existing lock, so
sibling commands are not cross-pair locked.

### 7. OCO-after-amend is not a cutover premise

Protection read-back proves that both own legs are active with the desired identity, attribution,
quantity, role, and trigger price. The implementation does not claim that a later fill of one amended leg
will cancel the other; no terminal transition or close correctness proof relies on that behavior. Close
performs explicit own-child cleanup regardless.

If a future capability requires exchange OCO as a correctness premise, it needs a separate Demo spike and
contract change. Building an ABI OCO engine in this cutover was rejected because no current requirement
needs it and it would introduce unproved replacement-order races.

### 8. Keep external contracts and durable schema stable while deleting a temporary error

Protection and close request/success DTOs remain unchanged. The temporary
`shared_scope_protection_unsupported` code is removed from the TypeScript union, result helper, route/OpenAPI
schema, and tests because valid same-side sharing now executes normally. All other public failures keep
their current envelope and secret-safe diagnostics.

The correlation schema, binding history, entry identity, close identity, and durable-before-write rules
remain unchanged. No migration record is required. Existing single-owner records are compatible because
their current entry identities and fill evidence feed the same generalized algorithms.

### 9. Verification proves path deletion, not only successful outputs

Tests are reorganized around invariant matrices rather than old/new branches:

- canonical entry mapping for first and joining same-side cycles;
- atomic same-side admission plus opposite-side/corrupt rejection;
- protection for owner count one and greater than one with the same adapter call pattern;
- close for owner count one and greater than one with own-fill quantity, durable identity recovery, exact
  execution proof, own-child cleanup, and sibling preservation;
- crash/timeout/retry points before and after each durable/exchange boundary;
- negative assertions that no legacy `Full`, `setTradingStop`, raw aggregate close quantity, shared-scope
  error, symbol-wide cancel, or sibling child identity is used.

Repository-wide static searches supplement behavioral tests so an unused but callable alternate path does
not survive unnoticed. Full `npm test`, typecheck, OpenAPI/contract checks, and strict OpenSpec validation
are required before rollout.

## Risks / Trade-offs

- **[Risk] A malformed or incomplete own fill query could produce a wrong close quantity.** → Reuse the
  existing strict exact-own decoder and bounded evidence; any ambiguity or contradiction fails before a
  close write, with no aggregate fallback.
- **[Risk] Aggregate physical state can change because a sibling acts concurrently.** → Treat aggregate as
  a veto/sanity snapshot only; exact own close execution and own child identities prove completion.
- **[Risk] Sequential child amend can leave a temporarily mixed desired state.** → Preserve Change 7's
  per-pair lock, fresh pre/post observations, typed whole-attempt failure, and no success until both legs
  match. No additional cross-pair lock is introduced.
- **[Risk] Cancelling one attached child can deactivate its sibling.** → Re-read the pair after every exact
  cancel and plan the next step only from fresh evidence; never issue two blind cancels.
- **[Risk] Existing Full-created legacy records may lack native Partial children.** → Cutover fails those
  cycles closed as non-attributed rather than creating replacement protection. Rollout acceptance starts
  from the explicitly approved branch/account state; any required legacy-state disposition is operational,
  not an automatic fallback in this change.
- **[Risk] Removing the legacy path makes rollback operationally heavier.** → Tag/record the pre-cutover
  commit and roll back the whole deployment to that boundary; do not mix binaries or toggle per request.
- **[Risk] OCO coupling after amend remains unknown.** → Do not use it as a proof or success condition; keep
  `PAIR/OCO BINDING AFTER AMEND: NOT PROVEN` explicit in rollout evidence.
- **[Trade-off] Same-side admission expands concurrency without a scope-wide lifecycle lock.** → This is
  intentional: safety is supplied by exact cycle identities and reduce-only writes, while unrelated pairs
  must remain independently operable.

## Migration Plan

1. Implement and verify the canonical Partial mapper; remove the separate builder and Full expectations.
2. Activate native protection and remove every legacy position-level production call and temporary error.
3. Generalize pair-scoped close, add exact native-child cleanup, and remove raw aggregate close behavior.
4. Remove the admission guard last within the same commit series, after all lifecycle tests pass; do not
   deploy an intermediate revision that admits sharing while legacy protection/close remains reachable.
5. Run strict OpenSpec validation, full tests, typecheck, OpenAPI checks, and repository-wide forbidden-path
   searches.
6. Deploy the single completed cutover revision under existing demo/testnet live gates. Mainnet remains
   blocked. Apply the separately approved Runtime→Engine timeout override operationally before final smoke.
7. Run final acceptance in two explicitly separated parts: single-owner new-path proof, then two same-side
   cycles with independent protection and close-one sibling preservation; also prove opposite-side rejection
   and recovery safety. Stop on any deviation.
8. Roll back only by redeploying the recorded pre-cutover Git boundary. Do not re-enable individual legacy
   paths or retain a mixed correlation/execution mode.

## Open Questions

None. OCO-after-amend is a documented non-premise, not a deferred design decision for this change.
