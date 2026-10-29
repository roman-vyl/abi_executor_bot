## ADDED Requirements

### Requirement: Bybit requests share one long-lived connection pool
ABI SHALL send every Bybit REST request (GET and POST) of its REST adapter
through one connection pool owned by that adapter. An idle connection SHALL be
kept open for `ABI_BYBIT_KEEPALIVE_TIMEOUT_MS` milliseconds, default `200000`.
A connection that is closed by the other side or broken SHALL be replaced by
the HTTP client's own mechanism on the next request; ABI SHALL NOT run its own
socket management or reconnect loop.

#### Scenario: Requests within the idle limit reuse the connection
- **WHEN** two Bybit requests are sent less than the idle limit apart
- **THEN** the second one uses the connection of the first

#### Scenario: A connection closed while idle is replaced without error
- **WHEN** the other side closes an idle pooled connection
- **AND** ABI then sends a Bybit request
- **THEN** the request goes out on a new connection and is answered

#### Scenario: Idle limit is configurable
- **WHEN** `ABI_BYBIT_KEEPALIVE_TIMEOUT_MS` is unset
- **THEN** the idle limit is 200000 ms
- **WHEN** it is set to a positive integer
- **THEN** that value is used
- **WHEN** it is present but not a positive integer
- **THEN** startup fails

### Requirement: A background heartbeat keeps the connection in use
ABI SHALL send `GET /v5/market/time` through the same adapter and pool once at
startup and then every `ABI_BYBIT_HEARTBEAT_INTERVAL_MS` milliseconds, default
`60000`; the value `0` SHALL turn the heartbeat off. A heartbeat SHALL NOT start
while the previous one is still running. A failed heartbeat SHALL be reported
and SHALL NOT stop later heartbeats. No trading operation SHALL wait for a
heartbeat or depend on its result, and readiness SHALL NOT depend on it.

#### Scenario: Heartbeat runs at startup and on the interval
- **WHEN** ABI starts with the heartbeat on
- **THEN** one heartbeat request is sent at once
- **AND** another one after each interval

#### Scenario: A failing heartbeat does not affect trading
- **WHEN** a heartbeat request fails
- **THEN** a `bybit_heartbeat_failed` warning is emitted
- **AND** entry, open-position, protection, close and recovery requests are handled as without the heartbeat
- **AND** the next heartbeat runs on schedule

#### Scenario: Heartbeat can be turned off
- **WHEN** `ABI_BYBIT_HEARTBEAT_INTERVAL_MS` is `0`
- **THEN** no heartbeat request is sent
- **WHEN** it is present but not a non-negative integer
- **THEN** startup fails

### Requirement: Shutdown stops the heartbeat and releases the pool
On shutdown, after the HTTP server has closed, ABI SHALL stop the heartbeat
and close the connection pool without delaying the process exit for idle
connections.

#### Scenario: No heartbeat after shutdown
- **WHEN** ABI receives SIGTERM
- **THEN** no further heartbeat request is sent
- **AND** the pool is closed

### Requirement: Connection health is observable
ABI SHALL emit a `bybit_connection_summary` event every 10 minutes with, for
that window: heartbeats succeeded and failed, new connections opened to Bybit,
connection errors, and GET repeats by reason (timeout, connection break).
`/health` SHALL show the heartbeat state (off, ok or failing), the time of the
last successful heartbeat and the number of consecutive failures, without
changing readiness.

#### Scenario: Summary shows connection reuse
- **WHEN** ten minutes have passed since start or since the last summary
- **THEN** one `bybit_connection_summary` event with the window's counters is emitted
