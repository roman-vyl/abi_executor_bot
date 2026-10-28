## Context

The facts store (`src/exchangeFacts/`) owns the database, its schema and the meaning of its rows; Bybit statuses are stored raw. Trading state lives in the correlation store (`src/correlation/`, append-only JSONL, one in-memory record per strategy instance + trade cycle, written only by the trading services under the per-pair lock). The stream recorder (stage 2) is the only writer of facts. This change adds the only writer of links. Owner: links come from ABI's own labels, without REST, and never through the trading path.

## Decisions

### D1. Owner, caller, moment

- Owner: the exchange facts module. New class `ExchangeOrderLinker` in `src/exchangeFacts/exchangeOrderLinker.ts`.
- Caller: nobody in trading. `startServer` creates it next to the recorder and starts it after the correlation replay succeeded; it runs on its own 1 s timer (`unref`), independent of the recorder's flush timer.
- Moment: each tick handles the facts the recorder stored since the previous tick, so a link normally exists 1–2 s after Bybit reported the order.
- Shutdown: the linker is stopped before the store closes; a tick in progress finishes (ticks are synchronous).

### D2. Label index (who owns a label)

- Source: a new read-only method `EntryPackageCorrelationRepository.listAllRecords()` returning the latest in-memory record of every pair, open and closed. Plain map read; no lock, no file read, no write.
- For each record with `generation` g ≥ 1 the linker computes, with the same `buildEntryPackageOrderLinkId` that trading uses, the labels of roles `entry` and `close` for every generation 1..g, and keeps `label → {strategyInstanceId, tradeCycleId, role, generation}`. Computed once per pair and generation (cache key pair + g), refreshed each tick for pairs whose generation grew or which are new.
- Older generations are covered because the label is a pure function of instance, cycle, role and generation; `binding_history` is not needed.
- If two different tuples ever give the same label, the label is marked ambiguous and orders carrying it are not linked (`own_label_ambiguous`).
- Before replay has finished, the linker does not tick (state `waiting_for_correlation`).

### D3. Classification of an order_state fact

Only `order_state` facts are classified, read in `event_seq` order (at most 1000 per tick, cursor in memory). An `orderId` that already has a link (in-memory set, loaded from `order_links` at start and kept up to date) is skipped.

| Record | Result |
|---|---|
| `orderLinkId` starts with `abi-ep-` and is in the index | `own` link: role and generation from the index, `orderLinkId` = label, evidence `own_order_link_id_lookup` |
| `orderLinkId` starts with `abi-ep-`, not in the index | waiting (`own_label_unknown`) |
| `orderLinkId` empty, `parentOrderLinkId` non-empty, `stopOrderType` `PartialStopLoss` or `StopLoss` | `child` link, role `stop_loss`, evidence `parent_order_link_id` |
| same, `stopOrderType` `PartialTakeProfit` or `TakeProfit` | `child` link, role `take_profit` |
| same, other `stopOrderType` | not linkable `child_type_unknown` |
| `orderLinkId` non-empty without the prefix | not linkable `foreign_label` (manual or other tool) |
| both empty | not linkable `no_label` (account-wide close-all, liquidation, ADL, manual) |

- `stopOrderType` is read from `raw_json`; the indexed columns give `orderLinkId` and `parentOrderLinkId`.
- A child link is written through the store's existing child rule: the parent must be an existing `entry` link. `parent_not_found` keeps the order waiting (its entry may be linked in a later tick); `parent_ambiguous` is not linkable, because links never change.
- Links are written per tick in one `writeLinks` call, entries before children, so a child whose entry arrived in the same tick is linked in that tick. If the call fails as a whole (`link_conflict` or invalid input aborts the transaction), the linker repeats the tick's links one by one so one bad order cannot block the others; the conflicting order is not linkable `link_conflict` and an event is emitted.

### D4. Convergence without deadlines

- Two sets in memory: **waiting** (ABI label or ABI parent label, not linked yet: `own_label_unknown`, `parent_not_found`) and **not linkable** (`foreign_label`, `no_label`, `child_type_unknown`, `parent_ambiguous`, `own_label_ambiguous`, `link_conflict`, `invalid_link` for a link the store refuses as invalid input). Both are derived only from database contents and correlation records, so they are the same whenever they are rebuilt.
- Every tick: classify the new facts, then retry every waiting order. No time limit, no give-up, no special trigger. Whatever adds the missing record (the live stream, a reconnect, later the stage 4 REST fill), the next tick links the order.
- Not linkable orders are not retried: the reasons cannot change while links are immutable and the order's label is fixed by Bybit.
- At start the linker reads all facts from `event_seq` 0 (1000 per tick) and the link set from `order_links`, which rebuilds both sets; already linked orders are skipped.
- A waiting order that stays waiting is a visible signal (health count per reason), not a state change. Expected cause: the entry record was lost in a WS drop; stage 4 fills it.

### D5. Facts covered by a link

A link is per `orderId`. All `order_state` facts of that order (create, amend, trigger, fill, cancel) and all `execution` facts with that `orderId` belong to the link's instance and cycle by `order_id`. No extra rows; executions are never classified. Executions without `orderId` (funding), records of unlinked orders and `account_snapshots` belong to no cycle.

### D6. Failures

- Every error in a tick (database read, write, label computation) is caught, counted, emitted as `exchange_order_linker_tick_failed` with an error code and no payload, and shown in `/health` as `lastError`. The next tick retries from the same cursor.
- A tick never throws into the HTTP server and never exits the process. Ticks are synchronous and bounded (1000 facts), so they cannot overlap or hold the event loop for long.
- With the store `disabled` or `unavailable` the linker is not created (`state: disabled` with reason).

### D7. Health and events

`/health.exchangeLinker`: `state` (`disabled`, `waiting_for_correlation`, `running`, `stopped`), `reason` when disabled, `lastTickAtMs`, `linksWritten` (since start), `waitingOrders` (object: reason → count), `notLinkableOrders` (object: reason → count), `lastError`. `ok` and the status code do not depend on it.

Events: `exchange_order_linker_started`, `exchange_order_linker_tick_failed` (`errorCode`), `exchange_order_linker_link_conflict` (`orderId`, `role`). No record payloads.

## Risks

- A label format change in trading without the linker would leave orders waiting (`own_label_unknown`), never mislinked; the linker uses the same function, and a test pins that.
- A child that arrives while its entry's facts are missing from the stream (WS drop) stays waiting (`parent_not_found`) until the entry record exists; stage 4 fills it from REST and the same pass links both.
- The startup rescan reads the whole facts table at 1000 facts per second; with today's volume (hundreds of orders per day) this is seconds.
