# exchange-stream-recorder Specification

## Purpose
Records the whole private Bybit WebSocket stream (order, execution, position, wallet) and its connection log into the exchange facts store, reconnecting forever and never stopping trading.

## Requirements

### Requirement: ABI records its private Bybit stream
ABI SHALL run an exchange stream recorder when the exchange facts store is
`enabled` and a Bybit API key is configured. The recorder SHALL connect to
the private WebSocket of ABI's configured Bybit environment, authenticate
with ABI's key, subscribe to `order`, `execution`, `position` and `wallet`,
and SHALL send no other request than auth, subscribe and ping.

#### Scenario: Recorder starts on demo
- **WHEN** ABI starts with `BYBIT_ENV=demo`, the store `enabled` and a key configured
- **THEN** the recorder connects to `wss://stream-demo.bybit.com/v5/private`, authenticates and subscribes to `order`, `execution`, `position`, `wallet`

#### Scenario: Recorder does not start without the store
- **WHEN** the store is `disabled` or `unavailable`
- **THEN** no WebSocket is opened and `/health.exchangeStream.state` is `disabled`

#### Scenario: Recorder does not start without a key
- **WHEN** the store is `enabled` and no API key is configured
- **THEN** no WebSocket is opened and `/health.exchangeStream` reports `disabled` with reason `no_api_key`

### Requirement: Every stream record is stored as received
Each element of `data[]` of an `order` or `execution` frame SHALL be stored as
an `order_state` or `execution` fact with source `ws`, and each element of a
`position` or `wallet` frame as an account snapshot, with the local receive
time and the element as `raw_json`. Records SHALL be written in batches of
one transaction per flush, at least every 1 s, at most 500 records per flush.

#### Scenario: Stop loss fill recorded
- **WHEN** the stream delivers an `order` Triggered record, an `execution` Trade record and an `order` Filled record for one stop-loss order
- **THEN** after the next flush two `order_state` facts and one `execution` fact exist for that `orderId`

#### Scenario: Funding row recorded if pushed
- **WHEN** an `execution` record with `execType` `Funding` arrives
- **THEN** it is stored as an `execution` fact with `exec_type` `Funding`

#### Scenario: Duplicate after reconnect
- **WHEN** the same `execId` arrives again after a reconnect
- **THEN** one fact exists

#### Scenario: Invalid record in a batch
- **WHEN** a flush contains one `execution` record without `execId` and other valid records
- **THEN** the valid records are stored, the invalid one is dropped and `exchange_stream_record_rejected` is emitted

### Requirement: Stream coverage is logged
The recorder SHALL store every connect attempt, auth result, subscribe
result, disconnect with close code and reason, and buffer overflow with its
time in the connection log, so periods without stream coverage can be
derived.

#### Scenario: Network drop
- **WHEN** the socket closes with code 1006 and the recorder reconnects 7 s later
- **THEN** the log holds `disconnected` with code 1006 and, after it, `connecting`, `connected`, `auth_ok`, `subscribed` rows with their times

#### Scenario: Silent connection
- **WHEN** no frame and no pong arrives for 60 s
- **THEN** the recorder terminates the socket, logs `disconnected` with detail `stale` and reconnects

### Requirement: Reconnect forever with backoff
After any disconnect, auth failure or subscribe failure the recorder SHALL
reconnect after 1, 2, 5, 10, 30 s, then every 30 s, and SHALL reset the delay
after staying subscribed for 60 s.

#### Scenario: Repeated auth failure
- **WHEN** auth fails on every attempt
- **THEN** attempts continue every 30 s after the fifth, and ABI keeps serving trading routes

### Requirement: Recorder never affects trading
No recorder failure SHALL stop the ABI process, throw into the HTTP server or
change any trading route's behaviour. The record buffer SHALL be bounded at
10 000 records; overflowing records SHALL be dropped and counted.

#### Scenario: Store write fails
- **WHEN** a flush fails with a non-validation store error
- **THEN** `exchange_stream_write_failed` is emitted, records stay buffered up to the bound and the next flush retries
- **AND** trading routes answer as before

#### Scenario: Buffer overflow
- **WHEN** more than 10 000 records are waiting
- **THEN** further records are dropped, `/health.exchangeStream.droppedRecords` grows and one `buffer_overflow` log row with the count is written when writing resumes

#### Scenario: Shutdown
- **WHEN** ABI receives SIGTERM
- **THEN** the recorder closes the socket and flushes its buffer once before the store is closed
