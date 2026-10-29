## Why

Owner plan 2026-10-29 (thread «Перевести вход на цену закрытия свечи касания», decisions 05:23 and 06:42). In
`touch_trigger` + `limit` a partially filled GTC Limit entry keeps its unfilled remainder live after Strategy Runtime
has moved the trade cycle to position management (accepted V1 limitation of `abi-touch-trigger-limit-entry-v1`).
Runtime will end that remainder when the original signal's lifetime is over. Runtime knows the trade cycle and the
expiry; ABI knows which exchange order belongs to the cycle. Runtime therefore sends only the pair
`strategy_instance_id` + `trade_cycle_id` and a command to cancel the unfilled remainder; ABI finds the parent order
through its existing correlation and checks its state.

The existing entry-package `CANCEL` cannot be used: it treats any fill as `filled_before_cancel` and fails closed.
Close already neutralizes a live, partially filled entry, but it also closes the position. This change adds one narrow
operation that reuses close's entry-neutralization steps and stops there.

## What Changes

- New endpoint `POST /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/entry-remainder/cancel`
  with a closed empty JSON object body `{}`.
- ABI resolves the pair's correlation record and its current entry order (`order_link_id`; one record per pair, one
  current binding; a new generation is never started after a fill). Allowed only for a record with a captured first
  fill (`first_fill_at_ms` non-null); otherwise `422 entry_not_filled`.
- Steps (the same helpers close uses in `neutralizeEntry`): classify the current entry order; terminal → no write;
  live / partially filled → cancel by its own `orderLinkId`, then confirm over bounded fresh reads that it is terminal.
- `200` answers: `entry_remainder_cancelled` (ABI sent the cancel and confirmed terminal) or
  `entry_order_already_terminal` (already filled in full, cancelled, or the cycle is `terminal_closed`), each with
  the entry order's confirmed `executed_quantity` (null only when answered from a `terminal_closed` record). Unconfirmed outcome → `500 internal_error` (Runtime retries).
- Never touches the position, the native SL/TP children, other pairs, or uses symbol-/account-wide cancel. No
  durable record change. Same pair-level mutex and live-execution guard as the other write operations.
- OpenAPI `docs/openapi/abi-position-management-api-v1.json` gets the operation. README / RUNBOOK: one paragraph.

## Unchanged

Entry-package `APPLY` / `CANCEL` / `REPLACE` (including `filled_before_cancel`), correlation record schema, close,
protection, open-position lookup, recovery, sizing, entry order shapes, `ema_anchor`. No timers in ABI, no expiry
knowledge in ABI, no new background work. ABI does not decide when to cancel: only Runtime calls it.

## Impact

- New capability `entry-remainder-cancellation`.
- Code: new route + `EntryRemainderCancelService` (reusing `classifyEntryOrderTerminality`, `cancelEntryOrder`,
  `confirmEntryOrderNeutralized`), server wiring, OpenAPI, docs, targeted tests.
- Runtime uses it in a separate change (`runtime-touch-trigger-remainder-cancel-v1`). Deploy ABI first: until Runtime
  calls it the endpoint is unused.
