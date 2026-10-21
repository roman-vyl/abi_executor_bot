## Context

See `proposal.md` for motivation. Today `PositionScope` and `positionScopeKey()` collapse the
configured account, category, symbol, and implicit `positionIdx = 0` into `category:symbol`.
`EntryPackageCorrelationRepository` is already authoritative by owner pair and can enumerate
multiple active records, but its scope view and replay conflict rule are instrument-level and
side-homogeneous. Entry admission, open-position, protection, close, and recovery are consequently
safe only under one-way geometry.

The correlation record stores each owner's immutable desired-entry side and exact exchange
category/symbol, but it does not state whether the order actually used one-way or hedge geometry.
That omission is harmless while every record means `positionIdx = 0`; it becomes ambiguous across a
future cutover. Side alone cannot repair the ambiguity because a historical long order at
`positionIdx = 0` did not occupy hedge slot 1.

## Goals / Non-Goals

**Goals:**

- Establish explicit internal identities for an instrument scope and its directional physical
  slots.
- Make ownership lookup and replay structurally slot-aware without enabling mixed-side production
  behavior.
- Preserve one canonical virtual side and derive hedge slot from it.
- Preserve truthful replay across the one-way-to-hedge transition.
- Keep current production writes and lifecycle behavior one-way until later cutovers.

**Non-Goals:**

- Switching the Bybit account mode or dispatching production orders with hedge `positionIdx`.
- Making open-position, protection, close, or recovery hedge-aware.
- Removing the mixed-side admission/readiness gate.
- Changing Runtime, Engine, public HTTP/OpenAPI contracts, risk sizing, owner identity, or the
  one-cycle-per-instance invariant.

## Decisions

### 1. Separate instrument scope from directional physical slot

Introduce two domain concepts:

- `InstrumentPositionScope`: configured account (implicit per process), exchange category, symbol;
- `DirectionalPositionSlot`: an `InstrumentPositionScope` plus domain direction `long | short`.

Provide different, collision-safe key functions for instrument scope and directional slot. A slot
key includes the direction; an instrument key does not. Call sites must choose the level they mean
instead of continuing to use an ambiguously named `PositionScope`.

The single configured account remains implicit because this change does not add multi-account
operation. The type documentation must nevertheless state that account is part of physical identity
operationally.

Alternative: append side directly to the existing scope key everywhere. Rejected because admission
still requires an instrument-wide compatibility check, while later lifecycle reads require a
specific slot. One overloaded key would keep those two meanings easy to confuse.

### 2. Keep numeric `positionIdx` in a pure Bybit encoding boundary

Domain code uses `long | short` directional slots. A pure exchange mapper owns the exhaustive table:

| Domain binding | Bybit `positionIdx` |
|---|---:|
| one-way | 0 |
| hedge long | 1 |
| hedge short | 2 |

This foundation adds and tests the mapper but does not wire hedge values into the production entry,
position-query, protection, close, or recovery paths. Current execution continues to select
one-way geometry explicitly.

Alternative: place `positionIdx` on domain scope types and correlation/public DTOs. Rejected because
it leaks exchange encoding into business identity and permits invalid integers outside the closed
mapping.

### 3. Persist binding geometry, but derive directional slot from desired-entry side

Add one internal correlation discriminator such as `position_binding_mode: "one_way" | "hedge"`.
Every new write after this foundation sets it explicitly. The existing production entry path writes
`one_way`; a later authorized entry cutover will be the first writer of `hedge`.

For a hedge record, the repository derives slot direction from `desired_entry.side`. It does not
store `positionIdx`, `physical_slot`, or a second side. The discriminator is not duplicate truth: it
records an otherwise unrecoverable historical fact about actual exchange geometry. Category,
symbol, side, order identities, and fills remain in their existing fields.

Alternative: infer all old and new slots from side. Rejected because it would falsely relabel real
`positionIdx = 0` history as hedge slot 1/2. Alternative: infer geometry from deployment version or
current config. Rejected because replay must remain truthful after rollback, restart, and mixed-era
logs.

### 4. Decode missing geometry as legacy one-way provenance, not as a hedge slot

The on-disk decoder accepts a missing discriminator only as the legacy format:

- latest durably closed legacy records are retained as historical one-way records and excluded from
  active ownership indexes;
- any latest active legacy record fails readiness with a specific diagnostic;
- records explicitly marked `one_way` remain valid active records after foundation deployment;
- records explicitly marked `hedge` require a non-null valid desired-entry side and derive a slot.

No JSONL rewrite or background migration is introduced. The deployment precondition is to drain all
active pre-foundation records before first rollout. This is stricter than silently adopting them but
is the only transition that does not fabricate physical placement.

Inspection of the immediate pre-foundation decoder confirms that it validates required field values
but does not reject unknown top-level keys. It therefore tolerates the additive discriminator and
continues to interpret foundation-written records through its one-way model. Rolling this foundation
back to that immediate predecessor is safe while every new record is explicitly `one_way`, as this
change guarantees. Once a later change writes the first `hedge` record, rollback to a decoder that
ignores geometry is forbidden and must use a hedge-aware rollback build or forward-fix.

### 5. Replace ambiguous scope access with explicit instrument and slot queries

The authoritative latest-record map remains keyed by `(strategy_instance_id, trade_cycle_id)` and
the JSONL store remains the only durable store. Repository APIs become explicit:

- enumerate active records for an instrument scope, including one-way and both hedge directions;
- enumerate active hedge records for one directional slot;
- reconstruct derived instrument and slot membership during replay.

The current single-pointer `byScope` must not become authoritative. It may be removed or replaced by
derived multi-value indexes, provided all indexes are reconstructible from latest pair records and
cannot discard siblings. Pair/order indexes and append serialization remain unchanged.

Alternative: create a new slot ownership database. Rejected because the correlation log already
contains owner, exchange identity, side, status, and with the discriminator, geometry.

### 6. Preserve admission with a separate instrument-level compatibility gate

Entry admission continues to lock the instrument-scope key and inspect the complete active
instrument set. It retains the current classifier semantics: empty and same-side are accepted;
opposite-side and corrupt are rejected before provisional durable write and before exchange I/O.

Slot-aware repository structure is therefore foundation, not activation. The lock must not switch
to slot-only yet: doing so would allow simultaneous long/short claims before lifecycle services can
manage them safely. Durable-before-exchange ordering and pair self-exclusion remain unchanged.

### 7. Replay separates structural reconstruction from the production activation gate

Replay first validates each latest record and derives its binding:

- explicit one-way → instrument-scoped ownership;
- explicit hedge + valid side → directional slot ownership;
- active legacy/malformed geometry → fail closed;
- durably closed → no current ownership.

It then applies the current production policy gate. Multiple same-side owners are valid. An active
long/short set on one instrument is reported as `unsupported_mixed_side_active_state`, not as a slot
key collision. Startup readiness remains false, so one-way lifecycle routes cannot operate on that
state. A later final admission/lifecycle cutover can remove only this policy gate without redesigning
the reconstructed indexes.

### 8. Public and pair-scoped contracts remain unchanged

No route, request, response, error code, or OpenAPI schema gains binding mode, directional slot, or
`positionIdx`. Runtime continues sending owner pair, ticker, and desired-entry side. OrderLinkId,
own-fill facts, parent-linked protection attribution, close identity, and pair mutex remain
pair-scoped and unchanged.

OpenAPI structural tests continue forbidding `positionIdx`. Internal serialization tests cover the
new correlation discriminator independently.

### 9. Subsequent dual-side changes are sequenced behind this foundation

Full support requires separate changes in this order:

1. account-mode assurance and operational drain/cutover procedure;
2. hedge entry execution: write `hedge`, encode slot on create, and confirm returned identity;
3. slot-specific position querying and open-position resolution;
4. slot-specific native protection read/reconciliation;
5. slot-specific close dispatch, aggregate sanity, and close recovery;
6. slot-specific ambiguous-create and entry-cycle recovery;
7. final mixed-side admission/readiness activation plus end-to-end Demo smoke.

Each lifecycle cutover must preserve own-order attribution and fail closed on slot mismatch. The
final gate is removed only after every production consumer of physical position state is slot-aware.

## Risks / Trade-offs

- [Active legacy binding exists at first rollout] → Preflight/drain check blocks deployment; replay
  also fails readiness rather than relabeling exposure.
- [A new one-way record omits the discriminator on one write path] → Exact serialization and replay
  tests cover every record constructor; replay treats active omission as legacy ambiguity and fails
  closed.
- [Developers use a slot query where instrument policy is required] → Distinct types and key/query
  names make the boundary explicit; admission tests prove the instrument lock remains.
- [Structurally valid mixed-side records reach current lifecycle services] → Replay/admission policy
  gate remains fail-closed until final activation.
- [A later hedge writer changes the rollback boundary] → The immediate predecessor tolerates this
  foundation's additive field and all foundation writes remain one-way; after the first authorized
  hedge write, only a hedge-aware rollback build or forward-fix is allowed.
- [Foundation mapper is mistaken for enabled execution] → No production mapper call site receives a
  hedge binding; structural tests prove entry/close remain on existing one-way paths.

## Migration Plan

1. Before deployment, enumerate latest correlation records and require every discriminator-less
   record to be durably closed; close/cancel active cycles through the existing verified lifecycle.
2. Stop new entry intake for the drain window and confirm no open orders or positions remain under
   the configured account for the affected deployment.
3. Deploy the foundation. Existing inactive legacy lines replay as historical one-way state; all new
   correlation writes carry explicit `one_way` geometry.
4. Restart once and verify replay/readiness, same-side multi-owner behavior, and absence of hedge
   exchange writes.
5. This foundation may roll back to the verified immediate predecessor because it ignores unknown
   top-level fields and all new records still mean one-way. After any later deployment writes
   `hedge`, rollback to that predecessor is prohibited. No durable record is rewritten during deploy
   or rollback.

The later Hedge Mode rollout begins only after the separately specified account-mode and entry
execution changes. It must again drain active explicit one-way records before switching new writes
to `hedge`; mixed-era durably closed history may remain in the log.
