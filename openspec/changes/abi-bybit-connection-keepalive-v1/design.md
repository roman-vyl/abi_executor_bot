## Context

`RestBybitAdapter` (`src/exchange/bybitAdapter.ts`) sends every Bybit request with the global `fetch` and no dispatcher, so Node's default undici agent closes an idle socket after 4 s. GETs go through `readWithRetry` (timeout `bybitReadTimeoutMs`, one retry on `TimeoutError`), POSTs through `signedPost` (timeout `bybitRequestTimeoutMs`, no retry). `startServer` (`src/app/server.ts`) builds one adapter for the whole process; `installShutdownHandlers` closes the HTTP server and then calls `onServerClosed`.

## Decisions

### D1. One pool, owned by the adapter
`RestBybitAdapter` creates one `undici.Agent` in its constructor:
`keepAliveTimeout = keepAliveMaxTimeout = bybitKeepAliveTimeoutMs`. No other option is changed (connections per origin stay unlimited, pipelining off). Every `fetch` of the adapter (signed GET, public GET, POST) passes `dispatcher: this.agent`. The global dispatcher is not touched, so nothing else in the process changes. Because Bybit sends no `Keep-Alive` hint, the client value is the effective idle limit.

`undici` is added as a dependency pinned to the exact version bundled with the image's Node (`process.versions.undici`), so the `Agent` and the built-in `fetch` speak the same internal interface.

### D2. Idle limit 200 s
Bybit Demo closes an idle connection at 240 s, mainnet at 300 s. 200 s keeps the client side shorter than both, so ABI drops an idle socket before the server does, and a request never goes out on a socket the server is closing at that moment. Configurable: `ABI_BYBIT_KEEPALIVE_TIMEOUT_MS` (positive integer, default `200000`, invalid fails startup like the other timeouts).

### D3. Heartbeat
A small class `BybitConnectionHeartbeat` (`src/exchange/bybitConnectionHeartbeat.ts`) gets the adapter, the interval and an `emit` function:

- `start()`: runs one tick at once, then every `bybitHeartbeatIntervalMs` via `setInterval` with `unref()`.
- A tick calls `adapter.getServerTime()` — the same public GET, the same pool, the same read timeout and retry as any other read. It does not run if the previous tick has not finished.
- A tick never throws: a failure emits `bybit_heartbeat_failed` (warn: reason, duration) and the next tick runs on schedule. Nothing waits for a tick, nothing reads its result except the counters.
- `stop()`: clears the timer; an in-flight tick is left to finish or be cut by its own timeout.
- `ABI_BYBIT_HEARTBEAT_INTERVAL_MS` (non-negative integer, default `60000`, `0` = heartbeat off, invalid fails startup). 60 s keeps the pool's socket used well inside both 200 s and 240 s.

`startServer` creates it right after the adapter and starts it; there is no readiness gate, entry handling does not look at it.

### D4. Retry reasons
`readWithRetry` keeps its shape (at most two attempts, fresh signature per attempt) and repeats on:

- `TimeoutError` (unchanged);
- a confirmed connection break: a `fetch` rejection whose `cause.code` is `UND_ERR_SOCKET` ("other side closed"), `ECONNRESET` or `EPIPE`.

Everything else is thrown on the first attempt: other `TypeError: fetch failed` causes (DNS `ENOTFOUND`, `ECONNREFUSED`, TLS certificate errors, `UND_ERR_CONNECT_TIMEOUT`), HTTP status errors (403 included) and Bybit `retCode` errors, which `readBybitResponse` raises from a received answer. `signedPost` is unchanged: no retry of any kind.

### D5. Shutdown
`startServer` passes to `installShutdownHandlers` an `onServerClosed` that stops the heartbeat, closes the exchange facts store (as today) and calls `adapter.close()`, which runs `agent.close()` without waiting (in-flight requests may finish; idle sockets are released). The process exit is not delayed by the pool.

### D6. Diagnostics
- Counters in the adapter: new connections (`connected` events of the agent's clients via `node:diagnostics_channel` `undici:client:connected`, filtered to the adapter's origin), connect errors (`undici:client:connectError`), GET retries by reason (`timeout`, `connection_closed`).
- Counters in the heartbeat: ok, failed, last ok time, consecutive failures.
- One `bybit_connection_summary` event (info) every 10 minutes with the counters of that window; one `bybit_heartbeat_failed` (warn) per failed tick. No per-request event.
- `/health` gets a `bybitConnection` block: heartbeat state (`off` / `ok` / `failing`), last ok time, consecutive failures. Readiness ignores it.
- With `ABI_DIAGNOSTICS_PATH` set, heartbeat GETs appear as `bybit_request_outside_operation` lines like the reconciler's (about 1 440 lines a day), which is how per-request latency stays measurable.

## How to check after deploy

- `bybit_connection_summary`: new connections per 10 min should drop from roughly one per Runtime request to about one per server-side close or VPN break; GET retries by reason.
- `abi_diagnostics.jsonl`: share of GETs cut at 1.5 s before vs after (2026-10-29 baseline: 9 of 199), and open-position durations.

## Risks

- Mixing a separately installed `undici` with Node's built-in `fetch` breaks if the versions drift; pinned to the bundled version and covered by a test that sends a real request through the agent to a local server.
- A POST can still meet a socket closed by the VPN in the same instant; it then fails through today's error path. Rare by D2/D3; not retried by design.
- The heartbeat adds 1 440 public requests a day. They are reads of server time, outside any trading path.
