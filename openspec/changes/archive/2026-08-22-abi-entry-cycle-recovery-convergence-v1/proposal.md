## Why

A live Demo incident proved that `entry-cycle-recovery-resolution` can positively establish
a trade cycle's true exchange state while the durable `EntryPackageExecutionRecord` it read
stays behind that proof forever.

Exact incident: `ema_pullback:eb191ae3ba1b9abaff3ad00a` /
`7c3f585f-eea7-4406-b974-8038353d84e7` / `abi-ep-f2f0a016cceb25e77afd`.

```
pending_create -> applied                              (2026-08-22T00:33:40.955Z)
applied -> unknown                                      (2026-08-22T04:34:40.372Z,
                                                          repeat-PUT revalidation returned
                                                          not_found/ambiguous during a
                                                          transient host/network
                                                          degradation window)
recovery-state resolves position_open, own fill proven  (2026-08-22T05:39:25.739Z)
first_fill_at_ms captured durably                        (same write)
status remains "unknown"                                (same write — untouched)
```

Every subsequent `GET .../open-position` for this exact pair returns `500 internal_error`
deterministically, because `open-position-resolution`'s `classifyStatus("unknown")` buckets
it `unresolved` and fails closed before any query — correctly, per that capability's own
unmodified contract, given what the durable record still says. The record is lying to every
later reader about a fact recovery itself already proved.

The network/sleep event that produced `unknown` is an operational trigger, not the defect.
The defect is architectural: `entry-cycle-recovery-resolution` already re-derives strictly
stronger, positively-evidenced truth on every call regardless of the durable `status` it
started from (its own gating checks only the three durably-closed statuses and
`order_link_id`, never the other six), but it durably writes back only one narrow field
(`first_fill_at_ms`, once, immutable). The record's lifecycle `status` never converges to
what recovery just proved.

This is not the first time this exact shape of gap was found and fixed. `abi-entry-cycle-
recovery-v1`'s own design already fixed the symmetric case on the closed side: a lost
`EntryPackageAbsent` response left `status:"absent"` durably correct but recovery's own
gate still failed forever, because recovery hadn't yet been taught to trust its own prior
durably-closed write. The fix there was narrow and explicit: check the durably-closed
status first, before falling through to the exchange-query path. That fix was deliberately
scoped to the three durably-closed statuses only — "a null `order_link_id` on a
non-durably-closed status (e.g. `unknown`) still fails safe exactly as before" (design.md,
verbatim). This change closes the open-side half of that same class of gap, for the states
`entry-cycle-recovery-resolution` can already positively prove today.

## What Changes

- Introduce an explicit, internal **Recovery Convergence** responsibility inside
  `entry-cycle-recovery-resolution`, architecturally separated from **Recovery Resolution**
  (the existing "what is currently proven?" logic, entirely unchanged by this proposal).
  Recovery Resolution keeps answering the caller exactly as it does today; Recovery
  Convergence is a new, narrow, pure decision — given an already-resolved outcome and the
  current durable record, decide `no_change` or a specific, guarded durable transition —
  applied by the existing write path under the existing pair mutex, through the existing
  `EntryPackageCorrelationRepository`.
- For each of the five outcomes `entry-cycle-recovery-resolution` already resolves today
  (`entry_order_live`, `position_open`, `terminal_without_fill`, `terminal_after_fill`,
  `entry_order_not_found`), define the exact set of current durable statuses eligible for
  convergence, the target status (if any), and the required guards (never a durably-closed
  status, never a live in-flight `pending_action`, never a legacy `pending_action`). See
  `design.md` for the full outcome-convergence matrix and the reasoning behind each cell,
  including the cells that resolve to explicit `no_change`.
- `position_open` is the outcome that resolves the live incident: an eligible non-durably-
  closed record with no in-flight `pending_action`, once `position_open` is positively
  proven, durably converges `status` to `applied` in the same locked write that already
  captures `first_fill_at_ms` — closing exactly the gap the incident exposed.
- Preserve every existing invariant this codebase already enforces elsewhere for durable
  writes: pair-scoped own evidence only (never aggregate position as ownership proof, per
  `entry-cycle-recovery-resolution`'s own existing veto-only aggregate rule, unchanged);
  `first_fill_at_ms` capture-once/immutable semantics (unchanged); no resurrection of a
  durably-closed cycle; no generation reset; no `binding_history` mutation; idempotent
  under repeated recovery calls (a converged record simply re-resolves the same outcome on
  the next call, with `no_change` the only possible decision from then on).
- No change to the public `GET /v1/.../recovery-state` response contract, to
  `GET /v1/.../open-position`'s own status-bucket contract, to the correlation record's
  schema/fields, or to Runtime. This change is entry-cycle-recovery-resolution-internal.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `entry-cycle-recovery-resolution`: add a Recovery Convergence responsibility that, after
  an outcome is already resolved by existing logic, may durably converge the correlation
  record's `status` (and, where specified, `pending_action`) toward that proven outcome,
  under explicit per-outcome guards; add the durable-write scenarios this introduces.

## Impact

- Affects only `src/services/entryCycleRecovery/` and the shared correlation write path it
  already calls (`EntryPackageCorrelationRepository.save`, existing `KeyedMutex`). No new
  file layout is mandated by this proposal beyond what `design.md` recommends.
- Does not change the public HTTP contract of `GET /v1/.../recovery-state` (still the same
  four-or-five-value union, still read-only with respect to the exchange) or of
  `GET /v1/.../open-position` (its own status-bucket classification is untouched — it keeps
  failing closed on `unknown`/`pending_create`/`create_failed` exactly as today; this
  proposal's effect is that fewer records are left sitting in those buckets after recovery
  has already proven something stronger, not a change to that classification itself).
- Does not change `EntryPackageExecutionRecord`'s schema. No new field, no migration.
  Existing durable rows already written as `unknown` (or any other non-durably-closed
  status) self-heal the next time recovery resolves a positive outcome for them — no
  backfill, no sweep, no batch job.
- Does not change Runtime. Runtime's periodic recovery worker, its own state machine, and
  its own marker handling are entirely out of scope — a converged ABI response is simply a
  stronger version of a response shape Runtime already knows how to interpret.
- Does not include a Runtime hard pre-orchestration gate. That is planned as a fully
  separate, later Runtime-side change once this ABI-side convergence exists to make such a
  gate meaningfully terminate rather than spin on a record that can never converge.
- Does not include a fix for the separately-discovered, structurally distinct
  terminal-fill-without-price gap (`isFillFactFinal()` treating a terminal order status as
  final even when `avg_execution_price` is absent). That gap did not cause this incident
  (the incident record's `early_execution_observation` stayed `null` throughout its
  history) and concerns price-completeness of a *fill fact*, not lifecycle-status
  convergence — a different capability concern with its own bounded-retry design question.
  It is deferred to a follow-up change (see `design.md`, "Deferred: terminal-fill-without-
  price").
- Does not include the independently-discovered, dormant Runtime `uncertain-removal +
  entry_order_not_found` gap (`_resolve_uncertain_removal()` missing a branch). That is
  Runtime-side, unrelated to this ABI-side change's mechanism, and was not live-triggered
  by this incident.
