## A. Problem statement

Live Demo incident, exact identity:
`ema_pullback:eb191ae3ba1b9abaff3ad00a` / `7c3f585f-eea7-4406-b974-8038353d84e7` /
`abi-ep-f2f0a016cceb25e77afd`. Durable correlation-store chronology, cross-matched to ABI's
own structured log (host bind mount `/app/var/abi_entry_package_correlation.jsonl`,
container never recreated across the incident):

| updated_at | status | pending_action | order_id | first_fill_at_ms | writer |
|---|---|---|---|---|---|
| 00:33:39.500Z | `pending_create` | `create` | `null` | `null` | `createOrder()` provisional write |
| 00:33:40.955Z | `applied` | `null` | `2209b9eb-...` | `null` | `createOrder()` confirmed write |
| 04:34:40.372Z | `unknown` | `null` | (unchanged) | `null` | `persistConfirmationOutcome()`'s `not_found`/`ambiguous` fallback, `entryPackageApplicationService.ts:747`, during a repeat-PUT revalidation that coincided with a transient host/network degradation window (independently corroborated by Market Data Service's own realtime-stream disconnects in the same narrow window) |
| 05:39:25.733Z | `unknown` (unchanged) | `null` | (unchanged) | `1787375456569` | `resolvePositionOpenResultLocked()`, `entryCycleRecoveryResolutionService.ts:359-364` — proves `position_open` via own attributable fill, captures `first_fill_at_ms`, **does not touch `status`** |

Every `GET /v1/.../open-position` issued after the last row deterministically returns
`500 internal_error`: `open-position-resolution`'s `classifyStatus("unknown")` buckets it
`unresolved` and fails closed before any query, exactly per that capability's own
unmodified, correct contract. The durable record is internally contradictory — it holds a
positively-captured, immutable fill timestamp and a lifecycle status that means "we don't
know what happened" — and nothing in the codebase ever reconciles the two.

The triggering network/sleep degradation is incidental. The defect is that
`entry-cycle-recovery-resolution` is already capable of establishing strictly stronger
truth than the durable `status` it started from — its own gating (`process()`) checks only
the three durably-closed statuses before running a full fresh dual-query resolution; it
does not special-case `unknown` (or `pending_create`, `create_failed`, `pending_cancel`,
`pending_replace`) at all — but of the five outcomes it can prove, only one narrow field of
one outcome (`position_open`'s `first_fill_at_ms`) is ever durably written back. `status`
itself never converges.

### Precedent already in this codebase

`abi-entry-cycle-recovery-v1`'s own design fixed the symmetric case on the closed side: a
positively-confirmed CANCEL wrote `status:"absent"`, but if the caller never received that
response, a later recovery-state query still hit the pre-fix `order_link_id === null`
fail-safe check and returned `500` forever — "even though ABI had already positively
confirmed the exact fact recovery exists to answer." The fix taught `process()` to check
`isDurablyClosedEntryPackageStatus` first. That fix was deliberately scoped to the three
durably-closed statuses only: "a null `order_link_id` on a non-durably-closed status (e.g.
`unknown`) still fails safe exactly as before." This proposal closes the open-side half of
that same class of gap — for exactly the outcomes `entry-cycle-recovery-resolution`
already proves today, no broader.

## B. Existing architecture / current behavior

`EntryCycleRecoveryResolutionService.process()` (`src/services/entryCycleRecovery/
entryCycleRecoveryResolutionService.ts`):

1. Look up the record by composite key. Missing record → `unknown_trade_cycle_binding`.
2. If `status` is one of the three durably-closed values, answer directly from that status
   — no exchange query, no further logic. **Convergence never runs for these records**;
   they are already durably correct by definition.
3. Otherwise, require a non-null `order_link_id`, then run a bounded (3-attempt/300ms),
   dual-query (own order + own close order + aggregate position, per outcome) resolution
   that can positively establish one of `entry_order_live`, `position_open`,
   `terminal_without_fill`, `terminal_after_fill`, or (for a narrowly-eligible ambiguous-
   CREATE shape, per the sibling change `abi-entry-order-not-found-recovery-v1`)
   `entry_order_not_found` — or fails safe (`internalErrorResult()`) when evidence is
   absent, contradictory, or incomplete. This step is `status`-agnostic beyond the
   durably-closed check above: it runs identically whether `status` is `applied`,
   `unknown`, `pending_create`, `create_failed`, `pending_cancel`, or `pending_replace`.
4. Exactly one durable write exists in this whole capability today:
   `resolvePositionOpenResultLocked()` captures `first_fill_at_ms` once, under the pair
   mutex, re-reading the record fresh first. Every other outcome, including
   `position_open` when `first_fill_at_ms` is already set, performs **no write at all**.

This makes the capability, in its own terms, a **read-only answer channel with one narrow,
deliberately-scoped state-repair carve-out** — not a reconciliation layer, by original
design intent (`abi-entry-cycle-recovery-v1`'s own stated non-goal: "Changing `GET
open-position` or its fail-closed behavior on an unresolved status. The new endpoint is
additive; the normal-path lookup is untouched.").

## C. Desired call chain

No new process, no new service, no new scheduler. The existing chain gains one internal
step between resolution and the HTTP response:

```
Runtime periodic recovery worker (unchanged, out of scope)
        │
        │ GET /v1/.../recovery-state
        ▼
EntryCycleRecoveryResolutionService.process()          [UNCHANGED]
        │  own-evidence dual-query resolution
        │  → one of 5 outcomes, or fail-safe
        ▼
NEW: RecoveryConvergencePolicy.evaluate(outcome, record) [NEW, pure]
        │  → { kind: "no_change" }
        │  or { kind: "converge", patch: Partial<EntryPackageExecutionRecord> }
        ▼
EntryCycleRecoveryResolutionService (existing locked-write call site, extended)
        │  applies patch via existing correlationRepository.save(),
        │  under the existing per-pair KeyedMutex
        ▼
HTTP recovery-state response (UNCHANGED shape)
        │
        ▼
Runtime existing recovery transition (unchanged, out of scope)
```

Runtime's hard pre-orchestration gate (marker-blocks-bar-processing-until-resolved) is
explicitly out of this proposal's scope — it is a separate, later Runtime-side change. This
diagram shows it only as the reason ABI-side convergence needs to exist first: a future
gate can only terminate meaningfully once ABI records that recovery can positively resolve
actually converge, rather than staying eligible for recovery forever.

## D. Recovery Resolution vs Recovery Convergence boundary

Two responsibilities, kept in two separate concerns inside the same capability:

**Recovery Resolution** (existing, entirely unchanged by this proposal): "what does
current pair-scoped own evidence positively prove, right now?" Owns all exchange querying,
all bounded-retry mechanics, all evidentiary rules (Decision 4's "absence of evidence is
never evidence of absence," the aggregate-veto-only rule, the legacy-`pending_action`
exclusions). Produces one of the five typed outcomes, or fails safe. Never reasons about
what the durable record *should become*.

**Recovery Convergence** (new): "given this already-resolved outcome and the current
durable record, what — if anything — should the durable record become?" A single pure
function, `RecoveryConvergencePolicy.evaluate(outcome, record) -> ConvergenceDecision`,
with **no HTTP, no Bybit adapter, no scheduler, no repository access, no mutex** — it takes
the outcome and the record snapshot already in hand and returns a decision value. It never
re-queries anything; if the record snapshot it's given is stale, the caller (the existing
locked write call site, mirroring `resolvePositionOpenResultLocked`'s own existing
re-read-fresh-under-mutex pattern) re-reads fresh before applying.

Concretely, in `src/services/entryCycleRecovery/`:

- `recoveryConvergencePolicy.ts` (new file): the pure decision function + its result type.
- `entryCycleRecoveryResolutionService.ts` (existing file, extended): the existing locked
  finalize step calls the policy after resolution and, on a `"converge"` decision, extends
  its existing `correlationRepository.save()` call to include the patch — the same write
  primitive, same mutex, same re-read-fresh-under-lock shape already used for
  `first_fill_at_ms`.

This mirrors exactly the separation the user specified: querying and policy never share a
function; the application layer (the existing service class) is the only thing that touches
the mutex and the repository.

```ts
// Illustrative only — exact types/signatures are an implementation decision, not fixed by
// this design.
type ConvergenceDecision =
  | { kind: "no_change" }
  | { kind: "converge"; patch: Partial<EntryPackageExecutionRecord> };

function evaluate(
  outcome: ResolvedRecoveryOutcome, // the 5 existing outcomes, unchanged shape
  record: EntryPackageExecutionRecord,
): ConvergenceDecision;
```

## E. Outcome-convergence matrix

Universal preconditions for every row below (all already true by construction before
Convergence ever runs, inherited from Recovery Resolution's own existing gating):
`record.status` is not durably-closed (`absent`/`terminal_unfilled`/`terminal_closed` never
reach Convergence at all — Resolution answers directly from them and returns before any
outcome is produced).

Per-outcome eligibility is expressed in terms of `pending_action`, since that field — not
`status` — is what actually distinguishes "a command is genuinely still outstanding, owned
by Runtime's own corrective machinery" from "we simply don't know what a past command did."

### `entry_order_live` / `position_open` (both carry `AppliedEntryPackage`)

Proves: this cycle's own `desired_entry` is genuinely live on the exchange (unfilled or
filled), exactly as durably recorded.

- **Eligible `pending_action`**: `null` or `"create"`. A `"create"` here is the direct
  positive mirror of `entry_order_not_found`'s negative case (the sibling change already
  in-repo, not yet archived): the create genuinely landed. Converge `status → "applied"`
  and, if `pending_action` was `"create"`, clear it to `null` — the create command's
  ambiguity is now positively resolved as success.
- **Excluded `pending_action`**: `"cancel"` — a cancel attempt is genuinely outstanding; the
  existing, already-specified Runtime behavior for `entry_order_live` ("if recovery finds
  the entry order still live while intent was removal, resend CANCEL") is Runtime's own
  corrective mechanism for exactly this case, per the ownership split established for this
  investigation (Runtime owns "what to do about it," ABI owns "what happened"). Silently
  converging `status` to `applied` here without also resolving the cancel's own fate would
  risk masking that a removal intent is still outstanding. **Decision: `no_change`.** Not
  disproven safe — simply untested by any live incident and deliberately deferred rather
  than guessed.
- **Excluded `pending_action`**: legacy `"amend"`/`"cancel_and_create"` — Resolution itself
  already refuses to resolve either outcome for these records (existing spec requirement:
  "A binding left mid-amend by a legacy pending_action never resolves a live-truth state").
  Convergence never even sees an outcome here; nothing to decide.
- **`order_id` guard for `entry_order_live` specifically**: every `applied`-status record
  observed in the live durable store has a non-null `order_id`, captured at the moment of
  the original confirmed create. `RecoveryEntryOrderSignal`'s `live_unfilled` variant
  (`packageConfirmation.ts`) does not currently carry the order's own `orderId` from the
  Bybit response, only its terminality/fill classification. **Open question, see section
  K**: converging `pending_create` (whose `order_id` is always `null` until confirmed) via
  `entry_order_live` would require either backfilling `order_id` from fresh evidence (a
  small extension to `RecoveryEntryOrderSignal`) or accepting an `applied` row with
  `order_id: null` (breaking an invariant every other `applied` row in this codebase's
  history has held). **This design recommends deferring `pending_create + entry_order_live`
  convergence** — guard convergence-to-`applied` on `order_id` already being non-null in the
  current record — and treating the `RecoveryEntryOrderSignal` extension as an explicit,
  separately-scoped follow-up if this combination is ever observed live. `position_open`'s
  own existing evidence chain already carries everything needed (own order-query response
  for price, own durable-or-freshly-captured `first_fill_at_ms`) — no equivalent gap there.
- **Idempotency**: an already-`applied`, `pending_action:null` record resolving
  `entry_order_live`/`position_open` again decides `no_change` (nothing to converge).

### `terminal_without_fill`

Proves: this cycle's own entry order is terminal with zero cumulative fill.

- **Eligible `pending_action`**: `null` or `"create"` (a create that is now positively
  proven to have never produced a live fill — the textbook shape a `create_failed`-named
  status exists for, though no current write path actually produces `create_failed`;
  `unknown` is what current code writes instead). Converge `status → "terminal_unfilled"`
  (not `"terminal_closed"` — this cycle never filled, so `terminal_unfilled`'s existing,
  narrower "no resurrection barrier beyond the ordinary one" semantics apply, exactly
  matching what `persistConfirmationOutcome`'s own `terminal_without_fill` branch already
  writes for its own, different call site). Clear `pending_action` to `null` if it was
  `"create"`. **Append a `binding_history` closing entry using the existing
  `closeBindingFrom(record, "exchange_terminal", now)` helper** — the same shape
  `entryPackageApplicationService.ts`'s own `terminal_without_fill` write already produces;
  convergence must reuse this exact helper, not a second implementation.
- **Excluded `pending_action`**: `"cancel"` — the dedicated cancel-confirmation path
  (`cancelLiveOrder`'s own revalidation-before-resend logic) already owns resolving "is my
  cancel done" for this exact shape; letting a second, generic path also write
  `terminal_unfilled` risks two independently-written `binding_history` closes for the same
  transition. **Decision: `no_change`**, let the existing dedicated path finish its own job.
- **Eligible current statuses in practice**: `unknown`, `applied` (a proven-terminal
  discovery for a record that never itself recorded any ambiguity — recovery reveals it
  independently), plus `create_failed`/`pending_replace` defensively (no current writer
  produces either, kept for schema completeness only).

### `terminal_after_fill`

Proves: this cycle's own entry filled and its own close order's confirmed fill exactly
matches. Resolution only reaches this outcome when `close_order_link_id` is durably
recorded, which in current code is only ever set by `CloseApplicationService`'s own
dispatch against an `applied`, `pending_action:null` record — so in practice this cell is
reached only from `unknown` (an applied, close-dispatched cycle that later degraded to
`unknown` before the close's own confirmation completed) with `pending_action` already
`null`.

- Converge `status → "terminal_closed"`, reusing **exactly** `CloseApplicationService`'s own
  existing terminal-closed write shape (same target fields, same `binding_history`
  end-reason convention) — this design does not introduce a second terminal-closed writer.
- Backfill `first_fill_at_ms` if not yet durably captured, mirroring `position_open`'s own
  existing capture-if-missing pattern (same primitive, same immutability guarantee).
- **Guard**: `pending_action` must be `null`. A close identity coexisting with any non-null
  `pending_action` is a structural contradiction Resolution itself does not currently model
  — defensively `no_change` (unreachable in practice, not a gap this proposal needs to
  close).

### `entry_order_not_found`

This outcome's own eligibility is **already fully specified and gated** by the sibling
change `abi-entry-order-not-found-recovery-v1` (in this repository, all code tasks
complete, not yet archived pending live-deployment verification): `status` in
`{pending_create, unknown}`, `pending_action` exactly `"create"`, non-null `desired_entry`,
valid `order_link_id`/`current_binding_started_at`, and no durable
fill/close/observation evidence. This proposal does not touch that gate.

- Convergence target: `status → "absent"`, clearing `order_link_id`/`order_id` to `null`
  and `pending_action` to `null` — **exactly** mirroring `confirmCancelOutcomeAndPersist`'s
  own existing successful-cancel write shape ("durably persists `status: "absent"` together
  with `order_link_id: null`"), not a new shape.
- **Do not generalize this outcome's semantics beyond what its own upstream eligibility gate
  already allows.** Because that gate already excludes any record carrying durable fill,
  close identity, or a non-`"create"` `pending_action`, Convergence for this outcome can
  never see an uncertain-*removal* topology or a previously-filled cycle — Resolution
  itself already prevents it. No additional guard is needed here beyond trusting the
  existing gate; this proposal explicitly does not extend `entry_order_not_found` handling
  to Runtime's separate, dormant `uncertain-removal` gap (out of scope, see Non-Goals).

### Summary table

| Outcome | Eligible `pending_action` | Target `status` | Other fields touched | Excluded cell → decision |
|---|---|---|---|---|
| `entry_order_live` | `null`, `"create"` | `applied` | `pending_action → null` if was `"create"`; **guard: `order_id` already non-null** | `"cancel"` → `no_change`; legacy → unreachable |
| `position_open` | `null`, `"create"` | `applied` | `pending_action → null` if was `"create"`; `first_fill_at_ms` capture-if-missing (existing mechanism, unchanged) | `"cancel"` → `no_change`; legacy → unreachable |
| `terminal_without_fill` | `null`, `"create"` | `terminal_unfilled` | `pending_action → null`; `binding_history` append via existing `closeBindingFrom(..., "exchange_terminal", ...)` | `"cancel"` → `no_change` (dedicated path owns it) |
| `terminal_after_fill` | `null` only | `terminal_closed` | `first_fill_at_ms` capture-if-missing; `binding_history` via existing close-write shape | any non-null → `no_change` (defensive, unreachable) |
| `entry_order_not_found` | `"create"` only (gate-defined upstream) | `absent` | `order_link_id`, `order_id`, `pending_action → null` | n/a — gate excludes everything else upstream |

## F. Durable transition invariants

- **Monotonic toward more certainty, never toward less.** Convergence only ever moves a
  non-durably-closed record either to another (more specific) non-durably-closed status
  (`unknown → applied`) or to a durably-closed one (`→ terminal_unfilled`/`terminal_closed`/
  `absent`). It never moves a durably-closed record anywhere — Resolution itself never
  produces an outcome for one (section B, step 2).
- **No resurrection.** A durably-closed record is never reachable by Convergence at all, by
  construction (same reason).
- **No duplicate CREATE.** Convergence never dispatches anything to the exchange — it is a
  pure decision over already-resolved evidence and a repository patch, applied through the
  existing write primitive. It cannot itself cause a create, cancel, or amend.
- **No generation reset, no `binding_history` destruction.** Every patch is additive
  (`status`, `pending_action`, and — for terminal outcomes — one new appended
  `binding_history` entry via the existing helper); `generation` and prior
  `binding_history` entries are never touched.
- **`first_fill_at_ms` capture-once/immutable is unchanged** — Convergence for
  `position_open`/`terminal_after_fill` reuses the existing capture mechanism exactly, it
  does not introduce a second one.
- **Pair-scoped own evidence only.** Every convergence decision is a function of an outcome
  Resolution already derived from this cycle's own order/close-order/execution evidence.
  The aggregate physical position query is never consulted by Convergence itself — it was
  already consulted (as a veto only) by Resolution, before Convergence ever runs.
  Convergence adds no new use of the aggregate query anywhere.
- **Fail-closed on insufficient evidence is unchanged.** Convergence only ever runs after
  Resolution has already positively resolved one of the five outcomes; when Resolution
  fails safe, Convergence is never invoked at all.

## G. Crash/retry/idempotency semantics

- The finalize step already re-reads the record fresh under the pair mutex before applying
  any write (existing `resolvePositionOpenResultLocked` pattern, reused unchanged for every
  outcome's convergence, not only `position_open`'s).
- A durable-write failure (e.g. a disk error) during convergence does not change the
  already-truthful HTTP response for that request — same existing behavior as
  `first_fill_at_ms`'s own try/catch. The next recovery call re-resolves the same outcome
  against the still-unconverged record and retries convergence; no retry counter, no
  backoff, no new durable bookkeeping.
- Repeated recovery calls against an already-converged record are provably idempotent: the
  policy is a pure function of `(outcome, record)`, and once `record` reflects the
  converged state, the same outcome recomputes to `no_change` on every subsequent call
  (e.g. `applied` + `pending_action:null` + `entry_order_live` → `no_change`, by the
  matrix's own "already there" reasoning — no special-casing required, it falls out of the
  guard conditions themselves).
- Concurrent recovery/other-writer races are already serialized by the existing per-pair
  `KeyedMutex` — convergence introduces no new lock, no new lock ordering, and no new
  cross-pair interaction.

## H. Non-goals

- No new microservice, background worker, scheduler, or event bus.
- No sleep/network/Docker degradation detection of any kind.
- No Runtime changes: no scheduling change, no hard pre-orchestration gate, no Boundary-B
  (`_resolve_uncertain_removal` + `entry_order_not_found`) fix. That Runtime-side gap is
  independent of this ABI-side mechanism and was not live-triggered by this incident.
- No `operator_required` status, no escalation, no retry-count persistence, no recovery-max-
  age/horizon concept of any kind.
- No sweep of historical ABI correlation records. Existing `unknown` (or other eligible)
  rows self-heal only the next time a live recovery call resolves a positive outcome for
  them — no batch job, no backfill.
- No `command_status`/`trade_status` schema split, no new durable field, no schema
  migration.
- No aggregate-physical-position ownership inference of any kind — unchanged from today.
- No manual-intervention workflow, no integrity/readiness checker.
- No broad refactor of `EntryPackageExecutionRecord`.
- No change to `entry_order_not_found`'s existing eligibility gate, and no extension of its
  semantics to uncertain-removal or previously-filled topologies.
- **Deferred, not included: terminal-fill-without-price.** `toObservation()`
  (`packageConfirmation.ts:608-610`) can produce a durable `EarlyExecutionObservation` with
  a terminal `order_status`, `cumulative_filled_qty > 0`, and `avg_execution_price:
  undefined` (a transient Bybit read-back gap), which `isFillFactFinal()` then treats as
  permanently final by status alone, with no price-completeness check. This is a real,
  separately-discovered structural gap — but it did not cause this incident (the incident
  record's `early_execution_observation` stayed `null` through its entire durable history;
  `unknown` here came from a repeat-PUT confirmation ambiguity, not from a stored
  fill-without-price observation), and it concerns a different axis (a *fill fact's* price
  completeness) than this proposal's concern (a *lifecycle status's* convergence to already-
  proven evidence). Fixing it would touch `isFillFactFinal()`'s semantics and
  `resolveOwnFillFacts()`'s reuse-vs-refresh decision — a bounded-retry design question of
  its own, unrelated to the convergence policy this proposal introduces. Including it here
  would mix two independent concerns into one change and one review. **Recommendation:
  separate, smaller follow-up change**, scoped narrowly to splitting "fill finality" from
  "price completeness" (e.g. an additive `isFillFactFinalAndPriced` check plus a bounded
  order-view re-poll on the narrow gap case), explicitly not touching the execution-list
  decoder and not designing weighted-average execution aggregation, per the existing
  forensic finding.

## I. Compatibility impact

- **Public API contract**: unchanged. `GET /v1/.../recovery-state`'s response shape (four
  or five outcomes, per the sibling change's own status) is untouched; this proposal adds
  no field, no outcome, no status code. `GET /v1/.../open-position`'s own status-bucket
  classification (`open-position-resolution`) is untouched — it keeps failing closed on
  `unknown`/`pending_create`/`create_failed` exactly as today. The observable effect is
  that fewer records remain in those buckets after a positive recovery outcome, not a
  change to the classification itself.
- **Runtime contract**: unchanged. Runtime's recovery-state decoding, its own state
  machine, and its marker handling receive the same typed outcomes they already know how
  to interpret; a converged ABI durable record is invisible to Runtime except as "a
  subsequent `GET .../open-position` for the same pair now succeeds instead of 500ing,"
  which is the intended fix, not a new contract surface.
- **Durable schema**: unchanged. No new field on `EntryPackageExecutionRecord`. No
  migration. `isValidEntryPackageExecutionRecord` and the repository's replay/regression
  checks (`fillFactRegression`, scope-index rebuild) are unaffected — convergence only ever
  writes values already valid under the existing schema and existing per-field invariants
  (`first_fill_at_ms` monotonicity in particular, already enforced independently by
  `fillFactRegression`).

## J. Regression plan

Minimum required cases (exact scenarios; test file organization is an implementation
decision):

1. **Live incident shape**: `status:"unknown"`, `pending_action:null`, `order_id` already
   set, no durable fill/close identity → recovery resolves `position_open` → durable
   `status` converges to `applied` in the same locked write that captures
   `first_fill_at_ms` → a subsequent `GET .../open-position` for the same pair no longer
   fails solely because of the stale `unknown` status.
2. **Idempotent retry**: the same unresolved cycle recovered N times in a row while
   evidence stays insufficient → `no_change` every time, no duplicate writes, no write at
   all beyond what Resolution itself already does.
3. **Idempotent re-recovery after convergence**: recovering the same pair again after
   convergence (now `applied`) re-resolves the same outcome → `no_change` — proves the
   guard conditions self-exclude an already-converged record without special-casing.
4. **Insufficient/ambiguous evidence never converges**: any case where Resolution itself
   fails safe → Convergence is never invoked, `status` stays exactly as it was.
5. **Durably-closed status is never touched**: for each of `absent`/`terminal_unfilled`/
   `terminal_closed`, Resolution answers directly (step 2) and Convergence never runs —
   prove no write of any kind occurs for these records via this path.
6. **In-flight `pending_action:"cancel"` guard**: `entry_order_live`/`position_open`/
   `terminal_without_fill` proven for a record with `pending_action:"cancel"` → explicit
   `no_change`, proving the intended deferral rather than an accidental omission.
7. **Legacy `pending_action` guard**: `"amend"`/`"cancel_and_create"` records — prove
   Resolution's own existing refusal to produce a live-truth outcome is unaffected, and
   that Convergence is correspondingly never invoked for those two outcomes.
8. **`entry_order_live`/`position_open` from `pending_action:"create"`**: proves the
   create-succeeded mirror of the sibling `entry_order_not_found` change — status converges
   to `applied`, `pending_action` clears to `null`.
9. **`pending_create` + `entry_order_live` is explicitly NOT converged** (per the deferred
   `order_id` guard in section E) — prove `no_change` and document why, so this is a
   deliberate, tested boundary rather than an untested gap.
10. **`terminal_without_fill` convergence** reuses `closeBindingFrom(..., "exchange_terminal",
    ...)` exactly — prove the appended `binding_history` entry is byte-identical in shape to
    `persistConfirmationOutcome`'s own existing write for the same outcome.
11. **`terminal_after_fill` convergence** reuses `CloseApplicationService`'s own existing
    terminal-closed write shape exactly — prove no second, divergent implementation exists.
12. **`entry_order_not_found` convergence** mirrors `confirmCancelOutcomeAndPersist`'s
    existing successful-cancel write shape exactly (`status:"absent"`,
    `order_link_id:null`) — prove no second, divergent implementation exists, and prove
    this path is unreachable for any record with durable fill/close identity (already
    guaranteed upstream by the sibling change's own eligibility gate, tested here only as a
    boundary confirmation, not a new gate).
13. **Crash-safety**: a durable-write failure during convergence returns the already-
    resolved (truthful) HTTP response unchanged; the record remains unconverged for the
    next attempt.
14. Full existing `entry-cycle-recovery-resolution` test suite continues passing unchanged
    — this proposal adds behavior, it does not alter any existing resolution scenario.

## K. Open questions

1. Whether/when to extend `RecoveryEntryOrderSignal`'s `live_unfilled` variant to carry the
   order's own `orderId`, to enable `pending_create + entry_order_live` convergence safely.
   Deferred; not blocking this proposal, since the live incident (and every currently-
   observed `unknown`-shaped record) already has a non-null `order_id`.
2. Whether `pending_action:"cancel"` + `entry_order_live`/`position_open`/
   `terminal_without_fill` should ever converge `status` (while leaving `pending_action`
   untouched) once Runtime's own corrective-CANCEL-resend behavior for `entry_order_live`
   is better characterized live — deliberately left `no_change` in this proposal pending
   real evidence, not designed around a hypothetical.
3. Exact TypeScript shape of `ConvergenceDecision`/`RecoveryConvergencePolicy` (file
   location confirmed as `src/services/entryCycleRecovery/`, exact type/function names are
   an implementation decision for `tasks.md` execution, not fixed here).
4. Whether the terminal-fill-without-price follow-up (section H) should land before or
   after this change — no ordering dependency exists between them; either sequence is safe.
