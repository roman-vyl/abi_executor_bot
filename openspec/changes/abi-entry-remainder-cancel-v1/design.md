## Context

- Correlation: one `EntryPackageExecutionRecord` per `(strategy_instance_id, trade_cycle_id)`
  (`correlationRecordKey`), with one current binding `order_link_id` / `order_id` / `generation`; earlier generations
  are in `binding_history` as ended. A new generation is created only from status `absent`
  (`handleNonNullDesiredEntry` → `createOrder(..., generation + 1)`), i.e. only after the previous order was confirmed
  gone without a fill. After a fill the current binding is the parent order whose remainder may be live.
- Runtime `REPLACE` always uses a new `trade_cycle_id`, i.e. a new record; generations of two cycles never mix.
- Close (`closeApplicationService.neutralizeEntry`) already does: `classifyEntryOrderTerminality` → if live
  `cancelEntryOrder` (live-execution guard) → `confirmEntryOrderNeutralized` (bounded fresh reads, terminal status
  decides, executed quantity does not).

## Decisions

### D1. A separate endpoint, not a new entry-package body

The entry-package `PUT` carries a desired entry and its contract states that any fill ends the entry phase. Folding a
remainder cancel into it would change that contract. A dedicated `POST .../entry-remainder/cancel` keeps the
entry-package and close contracts untouched and names exactly one action.

### D2. Precondition: the pair has a captured first fill

`first_fill_at_ms` is written once by open-position resolution on the first observed own fill. Runtime calls this
operation only in an open trade, i.e. after it observed that fill through ABI. A record without it is answered
`422 entry_not_filled` with no exchange call: cancelling an unfilled entry stays the entry-package `CANCEL`'s job.
Unknown pair → `422 unknown_trade_cycle_binding`. A record with a null `order_link_id` → `500 internal_error`
(contradictory correlation, as in close).

### D3. `terminal_closed` is answered from the record

Close proved the entry terminal before writing `terminal_closed`. The operation returns `entry_order_already_terminal`
for such a record without any exchange call, with `executed_quantity: null` (not re-read; the cycle is already
closed and Runtime no longer needs the number).

### D4. Same steps as close, then stop

Classify → (live) cancel by the record's own `orderLinkId` → confirm terminal. No position read, no protection
classification, no close order. `executed_quantity` = the confirmed order's `cumExecQty`. The operation writes no
durable record: a repeated request re-reads the exchange and gives the same answer (`entry_order_already_terminal`
after a successful cancel), so it is idempotent without state.

### D5. Native SL/TP children are not touched

The Partial children belong to the filled quantity. ABI does not cancel, amend or re-attribute them. Bybit keeps them
when the parent's remainder is cancelled (to be confirmed on Demo, see Risks); protection management keeps working
on the filled quantity through the existing `resolveCurrentOwnFilledQty`.

### D6. Concurrency and guard

The handler runs under the existing pair-level `mutex` (same as entry-package, protection, close), so it cannot
interleave with a close or protection of the same pair. The cancel goes through `cancelEntryOrder`, i.e. the
existing live-execution guard; `skipped_live_execution` or an unacknowledged cancel → `500 internal_error`.

## Answers

| HTTP | body | when |
|---:|---|---|
| 200 | `{strategy_instance_id, trade_cycle_id, status: "entry_remainder_cancelled", executed_quantity}` | cancel sent, terminal confirmed |
| 200 | `{..., status: "entry_order_already_terminal", executed_quantity}` | already terminal (`executed_quantity` null only for a `terminal_closed` record) |
| 400 / 415 / 422 | `malformed_json` / `unsupported_media_type` / `validation_failed` | body not `{}` |
| 422 | `unknown_trade_cycle_binding` | no record for the pair |
| 422 | `entry_not_filled` | record without `first_fill_at_ms` |
| 500 | `internal_error` | unconfirmed outcome, query failure, contradictory record, guard skip |

## Risks

- Bybit behaviour of Partial children when the parent's remainder is cancelled is not documented. Acceptance on Demo:
  after the cancel the filled position keeps exactly one stop and one take with qty = filled qty.
- A fill between classify and cancel: Bybit then rejects the cancel or cancels a smaller remainder; confirmation reads
  the terminal state, and `executed_quantity` reports the final executed quantity.
