## Why

Stage 3 of the ABI exchange facts journal. Stage 2 (`abi-exchange-stream-recorder-v1`, merged 33db609) stores every record of the private Bybit stream, but nothing says which strategy instance and trade cycle an order belongs to: `order_links` stays empty.

Owner decisions 2026-10-27/28:
- Links come from ABI's own order labels only, without REST lookups.
- The linking runs on its own, never called or awaited by trading code; a linking failure must not touch trading.
- Records that are not ABI trading orders (funding, liquidation/ADL, account snapshots, the account-wide cancel-all / close-all actions, manual orders) stay unlinked; that is expected.
- Owner 2026-10-28 04:07 «Пиши спек».

What already exists:
- ABI builds every entry and close `orderLinkId` deterministically: `abi-ep-` + sha256(`[strategyInstanceId, tradeCycleId, role, generation]`) (`buildEntryPackageOrderLinkId`, roles `entry` / `close`, generation 1..N). The provisional correlation record is saved before the order is sent, so the owner of a label is known before Bybit can report the order.
- Bybit sends the Partial stop loss / take profit children of an entry with an empty `orderLinkId` and `parentOrderLinkId` = the entry label (stage 0, XRPUSDT 2026-10-27).
- Amend and cancel keep the `orderId`, so every later state of an order is covered by one link.
- The store already has `order_links` with the immutable link rules (`exchange-facts-store`, design D5 of the foundation), including the child rule through `parentOrderLinkId`.

## What Changes

- New ABI component, the exchange order linker, in the exchange facts module (`src/exchangeFacts/`), the owner of the facts database and its links. It starts with ABI only when the exchange facts store is `enabled`, after the correlation store has been replayed.
- Every second it reads the new `order_state` facts and writes links:
  - own order: `orderLinkId` of an ABI label → `entry` or `close` link with the instance, cycle and generation that produced the label (evidence `own_order_link_id_lookup`);
  - child order: empty `orderLinkId`, `parentOrderLinkId` = entry label, `stopOrderType` `PartialStopLoss` / `StopLoss` → `stop_loss`, `PartialTakeProfit` / `TakeProfit` → `take_profit` (evidence `parent_order_link_id`);
  - anything else: not linked, counted by reason.
- Executions, all later order states and amendments are attributed through their `order_id`; no extra rows.
- Linking converges by itself, whatever the order and source of the records: every tick the linker retries all orders in the database that carry an ABI label (own or parent) and are still unlinked, without deadline. A child seen before its entry is linked in the tick after its entry. At startup the linker reads all facts once to rebuild this set. Owner 2026-10-28 04:39: no waiting periods or special retry paths ("одна проблема — одно решение").
- Completeness of the records is not this change: the source stays the WS stream with its reconnects (stage 2). REST gap filling and a completeness check are stage 4; whatever they add will be linked by the same pass.
- The only read from trading data: a new read-only method of the correlation repository listing every record (open and closed) in memory. The linker never takes the per-pair lock, never saves a correlation record and never calls Bybit.
- `/health` gets an additive `exchangeLinker` object (state, links written, unlinked ABI orders by reason, not linkable orders by reason, last error); `ok` and the HTTP status do not depend on it.

## Non-goals

- No REST lookups or gap filling (stage 4), no read API (stage 5), no Central Journal (stage 6).
- No storage schema change: `order_links` and the evidence values exist since schema version 1.
- No change to order execution, correlation writes, label format, live guard, Runtime ↔ ABI contract, Dockerfile or `bbb_stack`. The store stays disabled in production until the owner's word.
- No interpretation of states (no position, PnL or cycle status computed here).

## Trading safety, idempotency, recovery

- The linker only reads the in-memory correlation records and the facts database and writes `order_links`. It shares the process with trading, nothing else.
- Every linker failure is caught inside the linker, emitted as an event and shown in `/health`; it never throws into the HTTP server, never exits the process. Each tick is bounded (at most 1000 facts) so it cannot hold the event loop.
- Idempotency: links are immutable; writing the same link again is a duplicate, a different one is refused (`link_conflict`) and counted as an anomaly. Rescanning after a restart is safe.
- With the store `disabled` or `unavailable` the linker does not start; ABI behaves exactly as today.
