# exchange-rest-reconciliation Specification

## Purpose
ABI fills gaps of the private exchange stream from Bybit REST order and execution history (read only), records which time windows are covered, and reports what is still missing from the journal.

## Requirements

### Requirement: ABI fills stream gaps from Bybit REST history
When the exchange facts store is `enabled` and API keys are present, ABI SHALL
read `/v5/order/history` and `/v5/execution/list` (category `linear`) in
windows of at most 7 days with cursor pagination and store every record as a
fact with `source` `rest` and `sourceEndpoint` `rest:<path>`. It SHALL only
read; it SHALL NOT create, amend or cancel orders.

#### Scenario: Entry placed before the journal
- **WHEN** a cycle's entry was placed before the store existed and its stop loss child is stored from WS
- **THEN** the backfill stores the entry order from REST, the linker links the entry, and the child is linked in the next linker tick

#### Scenario: Same record from WS and REST
- **WHEN** an execution already stored from WS is fetched again by REST
- **THEN** no new row is written and it is counted as a duplicate

### Requirement: Startup backfill covers the last 30 days once
At start the reconciler SHALL fetch every interval of the last 30 days not
yet covered by completed windows of the endpoint, newest first. A restart
SHALL fetch only uncovered intervals.

#### Scenario: First start
- **WHEN** ABI starts with no completed windows
- **THEN** 5 windows per endpoint are fetched and recorded, and `exchangeRest.backfillDone` becomes true

#### Scenario: Restart
- **WHEN** ABI restarts after a completed backfill
- **THEN** only the interval from the last covered time to now is fetched

### Requirement: Reconnects and sweeps are reconciled
After every `subscribed` that follows a `disconnected` the reconciler SHALL
fetch the window from the disconnect time minus 120 s to now. Every 600 s it
SHALL fetch the last 3600 s.

#### Scenario: Network drop
- **WHEN** the stream is disconnected at 03:10:51 and subscribed again at 03:10:53
- **THEN** a window from 03:08:51 to the current time is fetched for both endpoints

### Requirement: REST load is bounded and stays away from bar closes
The reconciler SHALL send at most one request at a time, at least 500 ms
apart, and SHALL NOT send a request in the first 30 s after each 5-minute UTC
boundary. Overlapping queued windows SHALL be merged.

#### Scenario: Bar close
- **WHEN** a request is due at 10:05:04 UTC
- **THEN** it is sent at 10:05:30 UTC at the earliest

### Requirement: Coverage is recorded per completed window
A window SHALL be recorded in `rest_sync_windows` in the same transaction as
its last page of facts. A window that fails SHALL NOT be recorded and SHALL be
fetched again, after a backoff of 5 s, 30 s, then 60 s, without deadline.

#### Scenario: Request fails half way
- **WHEN** page 3 of a window times out after the retry
- **THEN** pages 1-2 stay stored, the window has no coverage row, `exchange_rest_request_failed` is emitted once for that error code, and the window is fetched again later

### Requirement: Completeness check reports what is missing
After every completed sweep ABI SHALL compute and report, without changing
any data: terminal orders whose stored `Trade` executions do not sum to
`cumExecQty`; stream gaps not inside completed windows of both endpoints;
`terminal_closed` cycles since the earliest covered time with no linked
`close`, `stop_loss` or `take_profit` order that has a `Trade` execution; and
orders seen only by REST without any label.

#### Scenario: All covered
- **WHEN** every gap is covered and every terminal order's executions add up
- **THEN** all four counts are 0

#### Scenario: Missing fill
- **WHEN** a `Filled` order with `cumExecQty` 10 has stored executions summing to 6
- **THEN** `execMismatchOrders` is 1 and the order id is in `exchange_completeness_checked`

### Requirement: Reconciler isolated from trading
Every reconciler failure SHALL be caught inside the reconciler, emitted and
shown in `/health`; it SHALL NOT throw into the HTTP server, block a trading
request or stop the process. With the store disabled or unavailable or
without API keys the reconciler SHALL NOT start.

#### Scenario: Store write fails
- **WHEN** the store throws on a write
- **THEN** the window stays queued, `exchangeRest.lastError` is set and trading routes answer as before
