## 1. Domain position identity foundation

- [x] 1.1 Replace the ambiguous physical `PositionScope` concept with explicit
  instrument-scope and directional-slot domain types while keeping the configured account implicit
  and documented.
- [x] 1.2 Add collision-safe, separately named instrument-scope and directional-slot key builders and
  migrate ownership call sites to the correct identity level.
- [x] 1.3 Add a pure exhaustive Bybit binding encoder for one-way `positionIdx = 0`, hedge long
  `positionIdx = 1`, and hedge short `positionIdx = 2`, without exposing numeric slots outside the
  exchange boundary.
- [x] 1.4 Add focused domain/mapper tests proving long and short slots differ under one instrument,
  one-way does not alias either slot, and invalid/unhandled geometry cannot be encoded.

## 2. Durable correlation geometry and compatibility

- [x] 2.1 Add the internal durable binding-geometry discriminator to the correlation record and make
  every current production record constructor write explicit `one_way` geometry.
- [x] 2.2 Update correlation validation/serialization so explicit `one_way` and `hedge` records are
  accepted, a hedge record derives its slot only from non-null valid `desired_entry.side`, and no
  numeric or duplicate directional slot is persisted.
- [x] 2.3 Decode a missing discriminator as legacy one-way provenance, allow latest durably closed
  legacy records without rewrite, and fail readiness with a specific diagnostic for any latest
  active legacy record.
- [x] 2.4 Verify and document the additive-field rollback boundary against the pre-change decoder;
  ensure the migration plan names a compatible rollback build or forward-fix if old code rejects the
  new field.
- [x] 2.5 Add replay fixtures for inactive legacy history, active legacy failure, active explicit
  one-way records, valid long/short hedge records, and malformed hedge records with missing side.

## 3. Slot-aware repository views

- [x] 3.1 Add an explicit active instrument-scope query returning one-way owners and owners from both
  directional slots without discarding siblings.
- [x] 3.2 Add an explicit active directional-slot query returning every matching hedge owner and no
  one-way or opposite-slot owner.
- [x] 3.3 Remove or demote the ambiguous single-pointer scope index/query so no ownership decision can
  mistake a latest writer for the full owner set; keep all derived views reconstructible from latest
  pair records.
- [x] 3.4 Preserve composite pair, order-link, order-id, append serialization, fill monotonicity, and
  binding-history behavior unchanged.
- [x] 3.5 Add repository tests for multiple owners in one slot, long and short sets under one
  instrument, release of one owner without affecting siblings, and restart reconstruction of all
  derived views.

## 4. Behavior-preserving admission and readiness gates

- [x] 4.1 Keep entry admission locked and classified at instrument scope, using the complete active
  instrument set so same-side remains admissible and opposite-side/corrupt remains rejected before
  durable requester state or exchange I/O.
- [x] 4.2 Preserve requesting-pair self-exclusion, durable-before-exchange ordering, and liveness for
  concurrent same-side and different-instrument requests after the key/query migration.
- [x] 4.3 Make replay distinguish long and short hedge slots structurally, then report an active
  mixed-side instrument as `unsupported_mixed_side_active_state` and keep startup readiness false.
- [x] 4.4 Add admission/replay tests proving the foundation does not permit production mixed-side
  ownership, while same-side multi-owner and different-instrument behavior remains unchanged.
- [x] 4.5 Add structural coverage proving no production entry, open-position, protection, close, or
  recovery path begins using hedge `positionIdx` as part of this change.

## 5. Contract, regression, and rollout verification

- [x] 5.1 Keep public entry-package, open-position, position-management, and recovery OpenAPI schemas
  free of binding geometry, directional-slot fields, and `positionIdx`; retain existing owner pair
  and error contracts.
- [x] 5.2 Run the full unit/integration suite and typecheck, including existing same-side ownership,
  protection attribution, pair-scoped close, recovery, dry-run, live-guard, and OpenAPI tests.
- [x] 5.3 Execute a pre-deployment correlation preflight against representative logs and prove active
  discriminator-less records block rollout while inactive legacy records require no rewrite.
- [x] 5.4 Perform a restart verification with explicit one-way records and confirm readiness plus zero
  hedge-mode exchange writes; do not run a mixed-side live smoke in this foundation change.
- [x] 5.5 Run strict OpenSpec validation and `git diff --check`, and confirm the implementation changes
  no Runtime/Engine repository or public contract.
