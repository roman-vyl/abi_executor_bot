## Why

A smoke test exposed a single architectural gap in two forms. When an entry-package
mutation's outcome is genuinely ambiguous (transport failure, or a bounded confirmation
that cannot establish a definitive result), ABI correctly durably records `status:
"unknown"` and preserves `pending_action` rather than guessing — but nothing in the
system today can take that `unknown` state to a resolved one. Runtime has no read path
that tolerates it (`GET open-position` fails closed with `500` for any unresolved
status) and no safe way to continue the specific mutation that went ambiguous.

Investigating the recovery path surfaced a second, independent problem: in-place amend
confirms a replace by comparing only quantity against the live order, because Bybit's
read-back prices are exchange-canonical and are intentionally not compared to raw
desired-entry text (`abi-entry-package-exchange-canonical-confirmation-v1`). That leaves
no reliable way to prove that a *new* desired entry, rather than the old one, is what is
actually live after an ambiguous amend — an ambiguous amend can neither be safely
confirmed nor safely retried. The plain CANCEL path has the same class of problem in a
smaller way: a transport exception during cancel does not durably record `unknown`
(unlike every other mutating path), and a repeat cancel-intent PUT resends the cancel
command without first checking whether the order is still there to cancel.

## What Changes

- Remove in-place amend and the atomic cancel-and-create replace from entry-package
  execution. Any change to an existing binding's desired entry other than nulling it out
  is now served by cancelling the existing order and returning `entry_package_absent`;
  ABI does not create a new order in the same request. Runtime applies a new desired
  entry only via a subsequent, independent CREATE. **BREAKING**: the entry-package wire
  contract's behavior for a non-null `desired_entry` against an existing live binding
  changes from applying the new entry to cancelling the existing one.
- Fix `cancelLiveOrder`'s transport-exception handling to durably record `status:
  "unknown"` before returning a safe error, matching every other exchange-mutating path.
- Add preflight exchange-state revalidation before a repeat cancel-intent PUT resends
  `cancelEntryOrder`, so ABI never blindly resends a cancel to an order it can already
  prove is no longer there to cancel.
- Add a new read-only recovery-state endpoint, keyed by `(strategy_instance_id,
  trade_cycle_id)`, that lets a caller establish ground truth for a trade cycle whose
  last mutation outcome was ambiguous, without side effects beyond the one explicit
  corrective action described below.
- Recovery-state resolution classifies the trade cycle into one of four states —
  `entry_order_live`, `position_open`, `terminal_without_fill`, `terminal_after_fill` —
  from a new composition of the existing order-history fill-priority classification and
  the existing position query, following the same bounded dual-query pattern
  `close-execution` already uses to verify both postconditions.
- The endpoint carries no time-based recovery horizon. Instead, correctness rests on one
  evidentiary rule: **absence of evidence is never treated as evidence of absence.**
  `terminal_without_fill` and `terminal_after_fill` are returned only when ABI has
  positively established that outcome (a definitively observed terminal-without-fill
  order status, or a definitively observed fill). A query that comes back clean-but-empty
  everywhere — no live order, no history match, no open position — proves nothing (the
  record could simply be outside what a current query can still see), so ABI returns its
  existing safe-error response instead of guessing, exactly as it already does for a
  genuine query failure.
- For `entry_order_live` and `position_open`, the response includes the full
  `AppliedEntryPackage` (`applied_desired_entry` + `calculated_quantity`) already
  durably held in the correlation record, so a caller can reconstruct its own aggregate
  without separately remembering the desired entry it originally sent.

## Capabilities

### New Capabilities
- `entry-cycle-recovery-resolution`: domain logic that resolves one Runtime-owned trade
  cycle's exchange ground truth (order + position) for recovery purposes, returning a
  terminal outcome only on positive evidence. Distinct from, and never a substitute for,
  `open-position-resolution`'s live-truth answer on the normal path.
- `abi-entry-cycle-recovery-api`: the public V1 Runtime → ABI HTTP contract for the new
  read-only recovery-state lookup.

### Modified Capabilities
- `entry-package-execution`: physical replace is removed. A desired-entry change on an
  existing binding is served exclusively by CANCEL, never by in-place amend or an atomic
  cancel-and-create. CANCEL's transport-failure and repeat-PUT handling gain the same
  safety symmetry create already has.

## Impact

- Affects `src/services/entryPackage/entryPackageApplicationService.ts` (remove
  `replaceAmend` and `replaceCancelAndCreate`, repoint the changed-desired-entry branch
  to the CANCEL path, fix `cancelLiveOrder`'s catch block, add preflight
  revalidation), `src/execution/execution.ts` (`amendEntryOrder` becomes unused —
  remove), `src/exchange/bybitAdapter.ts` (`amendOrder` becomes unused — remove), a new
  recovery-resolution service alongside `src/services/openPosition/`, a new route
  alongside `src/routes/openPositionRoutes.ts`, and `docs/openapi/`.
- Does not change Runtime, Strategy Engine, dry-run/live-execution guards, or the
  correlation-record schema — the new endpoint reads fields the record already durably
  stores (`desired_entry`, `calculated_quantity`, `current_binding_started_at`).
- Does not change `open-position-resolution` or `abi-open-position-lookup-api` — the new
  endpoint is additive and separate; the existing normal-path lookup is unaffected.
- `pending_action: "cancel_and_create"` becomes unused as a physical dispatch target;
  the value and its dispatch branch are removed.
- Affects dry-run/demo/testnet live-execution paths only in that they now issue a CANCEL
  instead of an amend or cancel-and-create for a changed desired entry; the live guard
  and mainnet block are unchanged.
