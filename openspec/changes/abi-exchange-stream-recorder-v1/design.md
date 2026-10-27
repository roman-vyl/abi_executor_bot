## Context

`startServer` receives the exchange facts store state (`disabled` / `enabled` / `unavailable`). The store is synchronous (`better-sqlite3`), runs in the ABI process, and offers `writeFacts` (one transaction per call, dedup, typed `ExchangeFactsWriteError`). Facts have kinds `order_state` and `execution` only (`CHECK` in schema v1).

## Decisions

### D1. Recorder lifecycle
`ExchangeStreamRecorder` is created in `startServer` after the HTTP routes, only when the store is `enabled` and `bybitApiKey` is non-empty; otherwise its state is `disabled` with a reason (`store_not_enabled`, `no_api_key`). `start()` returns immediately; all work happens in socket and timer callbacks. On shutdown the recorder closes the socket, flushes the buffer once, then the store is closed (existing `onServerClosed`).

### D2. Connection protocol
URL by `bybitEnvironment` (proposal). Auth: `{"op":"auth","args":[apiKey, expires, signature]}` with `expires = now + 10 000 ms` and `signature = HMAC_SHA256(secret, "GET/realtime" + expires)` hex. After `auth` success: `{"op":"subscribe","args":["order","execution","position","wallet"]}` (all-in-one topics). A failed auth or subscribe closes the socket and goes to backoff. `conn_id` from Bybit responses is kept for the log. Ping `{"op":"ping"}` every 20 s; any inbound frame resets the 60 s liveness timer; on expiry the socket is terminated and the close is logged as `stale`.

### D3. Backoff
Delays 1, 2, 5, 10, 30 s, then 30 s forever; reset to the first delay after a connection stays subscribed for 60 s. No give-up: the recorder keeps trying while ABI runs.

### D4. Record mapping
Only frames with `topic` in {`order`, `execution`, `position`, `wallet`} carry data; each element of `data[]` is one record, stored with `receivedAtMs` = local receive time and `rawJson` = the element re-serialized from the parsed frame (`JSON.stringify` of the element; numeric strings stay strings). `order` → fact `order_state`, `sourceEndpoint` `ws:order`; `execution` → fact `execution`, `ws:execution`; `position` → snapshot `position`; `wallet` → snapshot `wallet`. Control frames (`auth`, `subscribe`, `pong`) go only to the connection log (auth/subscribe) or liveness (pong). Unknown topics are counted and dropped.

### D5. Batching and bounded buffer
Records go into an in-memory buffer. Flush every 1 000 ms or when 500 records are buffered, whichever comes first; one flush = one store transaction containing its facts, snapshots and connection-log rows. The buffer holds at most 10 000 records; on overflow new records are dropped, the drop count is kept, and one `buffer_overflow` row (with the count) is logged when the buffer drains. A flush is synchronous and short (≤ 500 rows), so it never holds the event loop for long.

### D6. Failures inside a flush
- `ExchangeFactsWriteError` `invalid_fact` (e.g. execution without `execId`): the flush is retried record by record; invalid records are dropped with event `exchange_stream_record_rejected` (topic, reason, no payload); valid ones are stored.
- Any other store error (disk full, I/O): event `exchange_stream_write_failed` at level `error`, records stay buffered (bounded by D5), the next flush retries; `/health` shows `lastWriteError`.
- Parse errors of a frame: event `exchange_stream_frame_invalid`, frame dropped.
No error leaves the recorder.

### D7. Schema version 2 (additive migration)
```
CREATE TABLE account_snapshots (
  snapshot_seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_kind    TEXT NOT NULL CHECK (snapshot_kind IN ('position','wallet')),
  source           TEXT NOT NULL CHECK (source IN ('ws','rest')),
  source_endpoint  TEXT NOT NULL,
  symbol           TEXT,
  exchange_time_ms INTEGER,
  received_at_ms   INTEGER NOT NULL,
  dedup_key        TEXT NOT NULL UNIQUE,
  raw_json         TEXT NOT NULL
);
CREATE TABLE stream_connection_log (
  log_seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms        INTEGER NOT NULL,
  event        TEXT NOT NULL CHECK (event IN ('connecting','connected','auth_ok','auth_failed',
                 'subscribed','subscribe_failed','disconnected','buffer_overflow')),
  conn_id      TEXT,
  detail       TEXT
);
```
Dedup keys (new `snapshot_key_version` 1 in `schema_meta`): position `pos:{symbol}:{positionIdx}:{seq}` (Bybit position `seq`); wallet `wallet:{accountType}:{creationTime}:{sha256(raw)}` using the frame `creationTime`. Opening a v1 database runs both `CREATE TABLE`s and sets `schema_version` 2 and `snapshot_key_version` 1 in one immediate transaction; a new database is created at v2. A v2 database opened by the previous ABI image is refused as `exchange_facts_schema_newer`, which leaves the store `unavailable` and trading unaffected.

### D8. Health
`/health.exchangeStream`: `{ state: "disabled" | "connecting" | "subscribed" | "backoff", reason?, connectedSinceMs?, lastMessageAtMs?, reconnects, bufferedRecords, droppedRecords, lastWriteError? }`. Additive; `ok` and status unchanged. Events: `exchange_stream_connected`, `exchange_stream_disconnected` (code, reason, `stale`), `exchange_stream_auth_failed`, plus D6 events; no secrets, no payloads.

### D9. Dependency
`ws` 8.x pinned exactly in `dependencies`; `@types/ws` in `devDependencies`. Pure JavaScript (no native build), so the Docker build is unchanged.

## Risks

- Bybit limits private connections per account; ABI adds one. The Mac stage 0 probe (stops itself 2026-10-28 ~10:27Z) used one more without errors.
- Records missed while disconnected are not recovered until stage 4; the connection log makes the gaps explicit.
- Funding is not pushed on Demo WS (stage 0); it will come from REST in stage 4.
- The WebSocket uses the same Mac VPN/proxy path as REST; frequent 1006 drops are expected and only cost coverage, not trading.
