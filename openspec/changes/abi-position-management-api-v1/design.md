## Context

This defines only the public HTTP contract for the two position-management commands in
`proposal.md` — transport shape, DTOs, and what `2xx` is allowed to mean. It does not choose how
ABI internally confirms a write, attributes an order to a trade cycle, or resolves a position.
Those stay implementation, deferred the same way `entry-package-execution` was deferred from
`abi-entry-package-api`.

## Goals / Non-Goals

**Goals:**
- Distinguish "no live position to protect" from generic exchange-derived failure.
- Reuse `abi-open-position-lookup-api`'s exchange-scope code rather than inventing a parallel one.
- Make the close endpoint's body shape reject, not silently drop, any size-bearing input.
- Make protection confirmation numeric, not string-literal, while echoing Runtime's own values.
- Make full close conditional on unambiguous ownership within supported scope, not merely reachable.

**Non-Goal:** Internal ABI execution (exchange calls, order-attribution mechanics, retries, pending
state, partial close, webhook-driven external-close detection) is outside this change.

## Decisions

### 1. Route and error-vocabulary reuse
`PUT .../protection` and `DELETE .../open-position` remain the only two routes. `unsupported_exchange_scope`
is reused verbatim from `abi-open-position-lookup-api` — same meaning (resolved position's exchange
category outside V1 support), same HTTP status, no redefinition. `position_not_open` is genuinely
new: `unknown_trade_cycle_binding` covers an unknown *pair*, `unsupported_exchange_scope` is
knowable before any exchange call, and `internal_error` would hide a deterministic, actionable
outcome ("nothing to protect") behind the bucket reserved for exchange-derived ambiguity.

### 2. Protection confirmation is numeric equality with a fixed response body
Confirmation compares the exchange's reported stop/take to the request using exact-decimal numeric
equality, so formatting differences never block success but any real value change (e.g. tick-size
normalization) does. The response always echoes the values Runtime submitted, not whatever the
exchange echoes back, so Runtime never reconciles two representations of the same number.

### 3. The close endpoint's empty-body gate is a hard rejection, not a filter
Rather than accepting a body and ignoring unknown/size-bearing fields (the entry-package endpoint's
closed-object pattern), close treats any non-empty body as invalid outright. This is stricter than a
closed-object schema would be — a schema still has to define what's "unknown" per field; refusing
all body content removes that surface entirely, including for fields not yet imagined.

### 4. Close requires a resolvable, unambiguous, in-scope position before acting
Cancelling only pair-attributable orders defines *which* orders are touched; it does not say whether
ABI should act at all when the position itself can't be uniquely resolved. This decision gates every
write on that: unsupported scope (category only, matching `abi-open-position-lookup-api`'s existing
gate) fails with the reused business code; ambiguous or overlapping exposure — including symbol,
account, or position-slot ambiguity — that passes the category gate but still can't be uniquely
attributed fails with `internal_error`, matching that capability's precedent of routing
exchange-observed (not record-derived) uncertainty to the generic fail-closed code rather than a
further business code. `trade_cycle_closed` additionally requires the pair's stored correlation to
be complete and non-contradictory — a resolvable exchange position is necessary but not sufficient.

## Risks / Trade-offs

- [`position_not_open` gives Runtime one more code to branch on] → Accepted: folding it into
  `internal_error` would make a deterministic, expected outcome indistinguishable from genuine
  exchange trouble.
- [The ambiguous-ownership gate can reject a close a looser implementation would complete] →
  Accepted: a wrongly closed position or wrongly cancelled order is worse than a `500` Runtime must
  retry or escalate.
- [Rejecting any non-empty close body is stricter than the entry-package endpoint's closed-object
  pattern] → Accepted for a destructive, no-parameter action; there is no legitimate field this
  endpoint should ever accept.

## Migration Plan

Additive only; no existing route, DTO, or stored state changes. Production wiring is a separate,
later change.
