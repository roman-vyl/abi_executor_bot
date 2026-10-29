## Why

ABI's Bybit requests hang about once in 40 on the owner's Mac demo stack, also at low load. Network measurements on 2026-10-29 (Mac `BBB_data/abi/net_explore_20261029/`, `BBB_data/abi/keepalive_explore_20261029/`) located the hang:

- The Mac reaches Bybit through the Happ VPN (TUN mode). DNS and TCP connect finish in 1–2 ms (local tunnel); the TLS handshake of a NEW connection sometimes gets no ServerHello. Between 10% and 12% of new connections hung in a bad window, from the host and from the ABI and MDS containers alike, and 15% to a neutral host (Cloudflare). The VPN, not Bybit, is the cause.
- A connection that is already open never failed: 100 of 100 reused requests answered, about 220 ms each. Established connections also survived the VPN changing its exit country every ~30 s.
- ABI uses Node's global `fetch` (undici) with its default `keepAliveTimeout` of 4 s, which nobody chose. ABI asks Bybit in short bursts and then stays silent for minutes, so almost every Runtime request starts with a new TLS handshake — the exact step that hangs.
- Without the 4 s client limit, `api-demo.bybit.com` (CloudFront) closes an idle connection with a clean FIN after exactly 240 s (8/8), `api.bybit.com` after 300 s. Bybit sends no `Keep-Alive: timeout` header. With a long client timeout, requests after 5, 30 and 60 s of idle reused the connection 9/9; after 300 and 600 s the server had closed it and undici opened a new one without error.

So a longer keep-alive alone does not survive a 5-minute bar: the connection also needs a request at least every 240 s.

Owner decision 2026-10-29 18:04: minimal change of ABI's HTTPS client — one long-lived connection pool for `RestBybitAdapter` with `keepAliveTimeout` 200 s, a background heartbeat `GET /v5/market/time` every 60 s through the same pool (first one at startup), undici's own reconnection, the existing one-time GET retry extended to confirmed connection breaks, POST never repeated, clean shutdown, a few diagnostic events, tests. Only the network layer and its startup; trading services, Runtime contracts, SQLite, correlation and Recovery unchanged; no connection manager.

## What Changes

- `RestBybitAdapter` owns one undici `Agent` (keep-alive pool) and passes it to every `fetch` it makes, GET and POST. `keepAliveTimeout` = `ABI_BYBIT_KEEPALIVE_TIMEOUT_MS`, default `200000` (below Bybit Demo's 240 s idle close, so the client lets go first).
- New background heartbeat: `GET /v5/market/time` through the adapter every `ABI_BYBIT_HEARTBEAT_INTERVAL_MS`, default `60000`, first one right after startup; `0` turns it off. It never blocks or gates trading and is stopped on shutdown, after which the pool is closed.
- The existing single GET retry (today only on timeout) also fires on a confirmed connection break (`UND_ERR_SOCKET`, `ECONNRESET`, `EPIPE`). Still at most two attempts per GET. HTTP errors (403 included), Bybit `retCode` errors and any other fetch error are not retried. POST is never retried.
- Diagnostics: a `bybit_heartbeat_failed` warning per failed heartbeat and a `bybit_connection_summary` event every 10 minutes (heartbeats ok/failed, new connections opened, connect errors, GET retries by reason). `/health` shows the heartbeat state; readiness does not depend on it.
- New dependency `undici` pinned to the version Node 20 in the image bundles; README rows for the two variables.

## Non-goals

- No change to trading services, Runtime ↔ ABI contracts, the exchange facts store, the stream recorder, the reconciler, order correlation, mutexes, Recovery or `/health` readiness.
- No custom socket manager, reconnect loop, connection-readiness wait or queue. Lost connections are re-opened by undici on the next request.
- No POST retry of any kind. No retry of HTTP 403, `retCode` errors, DNS errors or refused connections.
- No change to the read timeout (1.5 s) or the write timeout (10 s).
- MDS and the VPN itself are out of scope (the VPN still needs a stable server on its own level).

## Trading safety, idempotency, recovery

- Only read-only GETs are repeated, as today; the added retry reason does not add a third attempt. Order writes are never repeated, so no duplicate orders.
- A POST that hits a connection the server has just closed fails as a POST fails today (existing error and Recovery paths). Keeping the client idle limit (200 s) below the server's (240 s) and the 60 s heartbeat make such a race rare; undici never writes to a socket it already knows is closed.
- The heartbeat is a public, unsigned, read-only request; its failure changes nothing in trading.
- Dry-run, demo/testnet execution and the mainnet guard are unchanged.
