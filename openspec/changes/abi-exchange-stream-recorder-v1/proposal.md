## Why

Stage 2 of the ABI exchange facts journal. Owner decision 2026-10-27: ABI subscribes to the whole private WebSocket stream of its Bybit account and writes everything into the exchange facts store; interpretation and links to trades come later (stage 3), gap filling from REST after that (stage 4).

Stage 0 (live Bybit Demo, 2026-10-26/27, probe `ws.mjs`) showed:
- `wss://stream-demo.bybit.com/v5/private` accepts auth and subscriptions to `order` and `execution`; the network on the Mac drops the connection about every 1–2 h (close 1006) and a reconnect takes 6–22 s.
- A real stop loss (XRPUSDT, 2026-10-27 12:47:54Z) arrived as `order` Triggered → `execution` (execId, execPrice, execQty, execFee, feeRate, execPnl, seq) → `order` Filled + take profit Deactivated, 2.5 min before Runtime recorded the closure.
- Entry order create and cancel (XRPUSDT, 19:30–19:35Z) arrived on `order` with `orderLinkId` `abi-ep-…`, a fraction of a second before Runtime recorded them.
- `parentOrderLinkId` is present on WS `order` records of Partial SL/TP children and absent on `execution`.
- On Demo, funding settlements at 16:00Z were booked (REST `execution/list`) but not pushed on WS `execution`.

The store (`exchange-facts-store`) already holds raw `order_state` and `execution` facts with deduplication and never stops trading (`abi-exchange-facts-trading-isolation-v1`). Nothing writes into it yet.

## What Changes

- New ABI component, the exchange stream recorder. It starts with ABI only when the exchange facts store is `enabled` and a Bybit API key is configured. It opens the private WebSocket of ABI's own environment (`demo` → `wss://stream-demo.bybit.com/v5/private`, `testnet` → `wss://stream-testnet.bybit.com/v5/private`, `mainnet` → `wss://stream.bybit.com/v5/private`), authenticates with ABI's key, and subscribes to `order`, `execution`, `position` and `wallet`. It only reads; it never sends an order request.
- Every record is stored as received: `order` → `order_state` fact, `execution` → `execution` fact (all `execType`), `position` and `wallet` → new account snapshot rows. Records are buffered in memory and written in one transaction per flush (every 1 s or 500 records), never one write per message.
- New connection log: every connect attempt, auth result, subscribe result, disconnect (close code, reason) and buffer overflow is stored with its time, so periods without stream coverage are visible.
- Liveness: ping every 20 s; no message or pong for 60 s closes the socket and reconnects. Reconnect with backoff 1, 2, 5, 10, 30 s (then every 30 s), forever.
- Storage schema version 2 (additive): new tables `account_snapshots` and `stream_connection_log`; a version 1 database is upgraded in place in one transaction at opening. `exchange_facts` and `order_links` are unchanged.
- `/health` gets an additive `exchangeStream` object (state, connected since, last message time, reconnect count, buffered records); `ok` and the HTTP status do not depend on it.
- New runtime dependency `ws` (Node 20 has no WebSocket client), pinned exactly, with `@types/ws` as dev dependency.

## Non-goals

- No links from facts to strategy instances or trade cycles (stage 3); `order_links` stays empty.
- No REST recovery of gaps, no funding from REST (stage 4), no read API (stage 5), no Central Journal (stage 6).
- No change to order execution, correlation store, live guard, Runtime ↔ ABI contract, Dockerfile or `bbb_stack`. Enabling the store on the Mac demo is a separate step on the owner's word.
- No interpretation of records (no position or PnL calculation).

## Trading safety, idempotency, recovery

- The recorder is read-only: it only authenticates and subscribes. It shares the process and the API key with trading, nothing else.
- Every recorder failure (connect, auth, parse, store write) is caught inside the recorder, emitted as an event and reflected in `/health`; it never throws into the HTTP server, never exits the process and never blocks a trading request for longer than one batch write.
- With the store `disabled` or `unavailable` the recorder does not start; ABI behaves exactly as today.
- Mainnet guard: the recorder sends no orders, so the live guard is not involved; on mainnet it would only read the account stream. The production stack keeps the store disabled.
- Idempotency: duplicates from reconnects or replays are dropped by the existing dedup keys (`execId`; order state fingerprint) and the new snapshot keys.
- Bybit sends no replay after a reconnect: records produced while disconnected are missing until stage 4. The connection log names those periods.
