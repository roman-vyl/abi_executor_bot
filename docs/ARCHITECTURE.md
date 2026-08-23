# MultiSpec Virtual Exposure Ownership — Current Architecture

Short current-truth summary of ABI's MultiSpec execution model. This replaces the
historical delivery-plan document as the canonical architecture reference.

## Core model

- **Pair-scoped identity**: every owned position/order is identified by
  `strategy_instance_id` + `trade_cycle_id`, not by symbol or side alone.
- **Multiple same-symbol same-side virtual owners are allowed**: two or more pairs can
  each hold their own virtual exposure on the same symbol and side simultaneously.
- **Aggregate exchange position is sanity/veto only** — it is never used as ownership
  proof. Ownership is always resolved from pair-owned fills and orders.
- **Own exposure is derived from pair-owned fills**, not from the aggregate exchange
  position.
- **Native Partial TP/SL is attributed through parent entry identity** — protection
  orders are matched back to their owning pair via the parent entry order's identity,
  not by symbol/side matching against the aggregate position.
- **Protection mutation is pair-scoped** — cancel/replace of stop-loss/take-profit only
  ever targets the requesting pair's own attached protection.
- **Close is exact own-exposure close** — a close request closes exactly the requesting
  pair's own resolved exposure, confirmed via the pair's own close-order identity, never
  by comparing against the aggregate position.
- **Recovery is pair-scoped** — recovery resolution operates on a single pair's durable
  state and live exchange evidence, not on the aggregate account state.
- **Recovery convergence is durable** — recovery state persists across restarts and
  converges deterministically from repeated fresh evidence rather than trusting stale
  in-memory state.
- **Opposite-side conflict fails closed** — if pair-owned state and live exchange
  evidence disagree on side, ABI refuses rather than guessing.
- **Legacy Full/shared-scope execution has been removed from the production path.** The
  destructive MultiSpec cutover eliminated the shared-scope code path entirely; there is
  no remaining fallback to non-pair-scoped execution.

## Known limitations / deferred items

- `abi-entry-order-not-found-recovery-v1` Phase A (ordinary fresh reconciliation for the
  order-not-found recovery path) remains stopped per that change's own tasks — it is not
  yet accepted and the change is still active, not archived.
- Close latency optimization is explicitly out of scope for this architecture and is
  tracked separately (see `perf/close-latency-instrumentation`).

## Evidence status

**Live proven** (observed in production):
- Multiple same-ticker same-side owners coexisting
- Distinct pair identities
- Distinct parent entry identities
- Distinct native TP/SL ownership
- Real recovery incidents occurred
- Recovery convergence works
- Pair-scoped close works

Everything else in this document is proven only by automated/integration tests, not by
live production observation, and should not be read as live-proven beyond the list above.
