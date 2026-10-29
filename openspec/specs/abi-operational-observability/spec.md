# Abi Operational Observability Specification

## Purpose

Gives Abi's process output a stable, machine-readable operational-event shape so future collectors and diagnostics tooling can consume it without parsing free-text log lines.

## Requirements

### Requirement: Structured Event Envelope
Every ABI-controlled operational event — i.e. every line emitted through the ABI event emission path defined by this capability — SHALL be exactly one single-line JSON object (no multi-line pretty-printed JSON, no bare/free-text lines). This requirement governs ABI-controlled emission only; it does not extend to output the Node.js runtime itself may write outside that path (e.g. an uncaught-exception stack trace printed before or without reaching the emitter). Each event SHALL include the base envelope fields `timestamp`, `level`, `service`, and `event`. `level` SHALL be exactly one of `info`, `warn`, or `error` — no other value is permitted. `service` SHALL be the fixed literal `"abi_executor_bot"`. Events with `level=error` SHALL be written to stderr; events with `level=info` or `level=warn` SHALL be written to stdout.

#### Scenario: Config startup dump is a single JSON line
- **WHEN** Abi starts and reports its resolved configuration
- **THEN** the output is one single-line JSON object containing `timestamp`, `level`, `service`, `event`, with no separate multi-line pretty-printed object

#### Scenario: Error-level event goes to stderr
- **WHEN** Abi emits an event with `level: "error"`
- **THEN** the event is written to stderr and not stdout

#### Scenario: Info and warn events go to stdout
- **WHEN** Abi emits an event with `level: "info"` or `level: "warn"`
- **THEN** the event is written to stdout and not stderr

#### Scenario: Invalid level is rejected
- **WHEN** an event would be emitted with a `level` value other than `info`, `warn`, or `error` (e.g. `debug`, `fatal`)
- **THEN** the event emission is a defect — `level` never takes on a value outside the three permitted ones

### Requirement: Service Lifecycle and Readiness Events
Abi SHALL emit structured events at the following lifecycle points, using these exact `event` values: `service_starting`, `server_listening`, `correlation_replay_started`, `correlation_replay_succeeded`, `correlation_replay_failed`, `readiness_ready`, `readiness_failed`, `shutdown_started`, `shutdown_completed`, `shutdown_failed`.

#### Scenario: Process startup
- **WHEN** the Abi process starts
- **THEN** it emits a `service_starting` event after `loadConfig()` succeeds and before `startServer()` begins; a `loadConfig()` failure is out of scope for this change and does not require a new structured error-handling path

#### Scenario: HTTP server begins listening
- **WHEN** the HTTP server successfully binds and begins listening
- **THEN** Abi emits a `server_listening` event

#### Scenario: Correlation store replay succeeds
- **WHEN** the entry-package correlation store replay starts and then completes without error
- **THEN** Abi emits `correlation_replay_started` followed by `correlation_replay_succeeded`, and subsequently emits `readiness_ready`

#### Scenario: Correlation store replay fails
- **WHEN** the entry-package correlation store replay starts and then fails
- **THEN** Abi emits `correlation_replay_started` followed by `correlation_replay_failed`, and subsequently emits `readiness_failed`

#### Scenario: Graceful shutdown succeeds
- **WHEN** Abi receives SIGTERM or SIGINT and the HTTP server closes without error
- **THEN** Abi emits `shutdown_started` followed by `shutdown_completed`, then exits with code 0

#### Scenario: Graceful shutdown fails
- **WHEN** Abi receives SIGTERM or SIGINT and the HTTP server's close callback reports an error
- **THEN** Abi emits `shutdown_started` followed by `shutdown_failed`, then exits with code 1

### Requirement: Execution Operation Events
For each of the four Runtime-facing execution operations (`entry_package`, `open_position`, `protection`, `close_position`), once the invocation reaches the instrumentation boundary as a successfully decoded application operation (transport rejected before decode — e.g. malformed request — does not count as a started operation), Abi SHALL emit an `operation_started` event, and IF that invocation subsequently reaches normal return or rejection at the instrumentation boundary, Abi SHALL emit exactly one terminal event — either `operation_completed` or `operation_failed` — never both. An `operation_started` event with no corresponding terminal event yet observed is not a contract violation: it signals the invocation is currently in flight, hung, or that the process terminated before completion — a diagnostic signal in its own right, not a guaranteed pairing.

`operation_started` and `operation_completed` events SHALL use `level: "info"`. `operation_failed` events SHALL use `level: "error"`.

`operation_started`, `operation_completed`, and `operation_failed` events SHALL include an `operation` field naming which of the four operations it is. `strategy_instance_id` and `trade_cycle_id` SHALL be included on both `operation_started` and the terminal event for that same invocation — required, not conditional — since only a successfully decoded invocation reaches `operation_started` in the first place. Terminal events SHALL include `outcome` and `duration_ms`.

The `operation_completed`/`operation_failed` choice SHALL be decided by the resulting `outcome`, not by Promise mechanics (normal return vs throw/reject) alone — an application service MAY catch an internal exception and return a typed `internal_error` outcome as a normal Promise resolution, and that case SHALL still be classified as `operation_failed`. Precisely:
- a normal typed result whose outcome is a handled business-negative outcome (e.g. `position_not_open`, `unknown_trade_cycle_binding`, `unsupported_exchange_scope`) SHALL produce `operation_completed` at `level: "info"`, independent of the HTTP status code the caller ultimately receives;
- a normal typed result whose outcome is `internal_error` SHALL produce `operation_failed` at `level: "error"` with `outcome: "internal_error"`;
- an unexpected thrown exception or rejected promise reaching the instrumentation boundary (not caught into a typed result by the service) SHALL likewise produce `operation_failed` at `level: "error"` with `outcome: "internal_error"`.

Instrumentation SHALL NOT change existing service behavior or existing exception-to-typed-`internal_error` handling — it only classifies whatever typed outcome or uncaught exception already reaches the instrumentation boundary.

`outcome` SHALL carry the specific result of a terminal event (e.g. `entry_package_applied`, `entry_package_absent`, `position_open`, `position_closed`, `protection_applied`, `trade_cycle_closed`, `position_not_open`, `unknown_trade_cycle_binding`, `unsupported_exchange_scope`, `internal_error`) rather than the result being encoded as a distinct `event` value. The outcome vocabulary for each operation SHALL be derived from that operation's existing production result/status/error types as a typed union — not a new, parallel error vocabulary invented for observability alone. For `open_position`, whose existing result is a boolean success indicator, the derived observability outcomes SHALL be `position_open` and `position_closed`.

#### Scenario: Successful entry package application
- **WHEN** an entry-package operation reaches the instrumentation boundary as a decoded invocation and runs to a normal typed result
- **THEN** Abi emits `operation_started` (`level: "info"`) with `operation: "entry_package"`, `strategy_instance_id`, and `trade_cycle_id`, followed by exactly one `operation_completed` event (`level: "info"`) with `operation: "entry_package"`, `strategy_instance_id`, `trade_cycle_id`, an `outcome` describing the result, and `duration_ms`

#### Scenario: Handled business-negative result stays completed
- **WHEN** any of the four execution operations reaches a normal typed result that represents a handled business condition (e.g. `position_not_open`, `unknown_trade_cycle_binding`, `unsupported_exchange_scope`) rather than an unexpected failure
- **THEN** Abi emits `operation_completed` (`level: "info"`) with that `outcome` — not `operation_failed`

#### Scenario: Uncaught exception becomes a failed, error-level event
- **WHEN** any of the four execution operations throws or rejects unexpectedly at the instrumentation boundary (not caught into a typed result by the service itself)
- **THEN** Abi emits `operation_started` for that operation, followed by exactly one `operation_failed` event (`level: "error"`) with `operation`, `outcome: "internal_error"`, `strategy_instance_id`, `trade_cycle_id`, and `duration_ms`, and no `operation_completed` event for that same invocation

#### Scenario: Typed internal_error return also becomes a failed, error-level event
- **WHEN** any of the four execution operations catches an internal exception itself and normally returns (not throws) a typed result whose outcome is `internal_error`
- **THEN** Abi emits `operation_started` for that operation, followed by exactly one `operation_failed` event (`level: "error"`) with `operation`, `outcome: "internal_error"`, `strategy_instance_id`, `trade_cycle_id`, and `duration_ms`, and no `operation_completed` event for that same invocation — the classification follows the outcome, not whether the service resolved or rejected the Promise
- **AND** the service's own exception-to-typed-`internal_error` handling is unmodified by instrumentation

#### Scenario: Terminal events are mutually exclusive
- **WHEN** any of the four execution operations reaches normal return or rejection at the instrumentation boundary
- **THEN** the invocation produces exactly one terminal event — `operation_completed` or `operation_failed`, never both — for that `operation_started`

#### Scenario: Started without a terminal event is a diagnostic signal, not a violation
- **WHEN** an `operation_started` event has been emitted and the process hangs, is still processing, or terminates before a terminal event is emitted
- **THEN** the absence of a terminal event is treated as an in-flight, hung, or incomplete-invocation signal — not evidence of a broken started/terminal pairing

### Requirement: Sensitive Data Exclusion
No operational event emitted by Abi SHALL include secrets (API keys, credentials, signing material) or raw/sensitive exchange request or response payloads in any field.

#### Scenario: API key is not logged
- **WHEN** Abi emits any operational event, including lifecycle and execution events referencing exchange configuration
- **THEN** no field contains the raw Bybit API key or secret

#### Scenario: Raw exchange payloads are not logged
- **WHEN** Abi emits an `operation_completed` or `operation_failed` event for an execution operation that involved a Bybit request/response
- **THEN** the event does not include the raw request or response body — only structured fields such as `operation`, `outcome`, identifiers, and `duration_ms`

### Requirement: Entry-package failures name their stage and cause
Every `entry_package` `operation_failed` event SHALL include `failure_stage` (one of
`admission_write`, `instrument_resolution`, `quantity_calculation`, `binding_mode`,
`scope_admission`, `provisional_write`, `exchange_create`, `confirmation`, `unexpected`)
taken from the typed internal result, and `error_cause`: exception class and message
truncated to 300 characters, or a fixed reason such as `scope_conflict`.

#### Scenario: Quantity calculation throws
- **WHEN** an entry-package PUT fails because quantity calculation threw
- **THEN** `operation_failed` carries `failure_stage: "quantity_calculation"` and the
  exception class and message in `error_cause`

#### Scenario: Scope conflict is named
- **WHEN** an entry-package PUT fails on scope admission without an exception
- **THEN** `operation_failed` carries `failure_stage: "scope_admission"` and
  `error_cause: "scope_conflict"`

#### Scenario: Failure without a recorded stage
- **WHEN** an entry-package `internal_error` carries no recorded stage
- **THEN** `operation_failed` carries `failure_stage: "unexpected"` and
  `error_cause: "not_recorded"`

#### Scenario: No secrets or payloads
- **WHEN** any `operation_failed` event for `entry_package` is emitted
- **THEN** `error_cause` contains no raw exchange payload and no credentials

### Requirement: Pre-exchange rejection emits one event
When ABI durably persists `absent` for a pair because its PUT failed before the exchange
boundary or because startup closed a leftover `admission_pending` record, it SHALL emit
exactly one `entry_admission_rejected` event at `level: "warn"` with
`strategy_instance_id`, `trade_cycle_id` and `failure_stage` (`startup_recovery` for the
startup case).

#### Scenario: Scope conflict rejection
- **WHEN** a new pair is rejected by scope admission and its record becomes `absent`
- **THEN** one `entry_admission_rejected` event with `failure_stage: "scope_admission"` is
  emitted

### Requirement: Startup reports the exchange facts store
The `service_starting` event SHALL include `exchangeFactsStore` with value
`disabled`, `enabled` or `unavailable`, computed after the open attempt. When
it is `enabled`, the event SHALL also include `exchangeFactsSchemaVersion`. A
failure to open or check an enabled store SHALL emit
`exchange_facts_store_failed` at level `error` with a closed `reason`, and
startup SHALL continue without the store.

#### Scenario: Store disabled
- **WHEN** ABI starts with `ABI_EXCHANGE_FACTS_ENABLED=false` or unset
- **THEN** `service_starting` includes `exchangeFactsStore: "disabled"`
- **AND** no facts database file is created or opened
- **AND** the SQLite native module is not loaded

#### Scenario: Store enabled
- **WHEN** ABI starts with `ABI_EXCHANGE_FACTS_ENABLED=true` and the store opens
- **THEN** `service_starting` includes `exchangeFactsStore: "enabled"` and `exchangeFactsSchemaVersion: 1`

#### Scenario: Store cannot open
- **WHEN** the store is enabled and opening or checking fails
- **THEN** ABI emits `exchange_facts_store_failed` with `reason` one of `open_failed`, `exchange_facts_driver_unavailable`, `exchange_facts_environment_mismatch`, `exchange_facts_unknown_database`, `exchange_facts_schema_newer`, `exchange_facts_dedup_rule_unknown`
- **AND** the event contains no secrets and no file contents
- **AND** `service_starting` includes `exchangeFactsStore: "unavailable"`
- **AND** ABI listens and serves every trading route as with the store disabled

### Requirement: Health reports the exchange facts store
`GET /health` SHALL include `exchangeFactsStore` with the startup state
(`disabled`, `enabled` or `unavailable`) and, when `unavailable`,
`exchangeFactsStoreReason` with the failure reason. The store state SHALL NOT
change `ok` or the HTTP status of `/health`.

#### Scenario: Unavailable store keeps health status
- **WHEN** the store is `unavailable` and the entry package path is ready
- **THEN** `/health` answers 200 with `ok: true`, `exchangeFactsStore: "unavailable"` and `exchangeFactsStoreReason`

#### Scenario: Disabled store
- **WHEN** the store is disabled
- **THEN** `/health` includes `exchangeFactsStore: "disabled"` and no `exchangeFactsStoreReason`

### Requirement: Health reports the exchange stream
`GET /health` SHALL include `exchangeStream` with `state` (`disabled`,
`connecting`, `subscribed`, `backoff`, `stopped` during shutdown), the disabled `reason` when disabled,
`connectedSinceMs`, `lastMessageAtMs`, `reconnects`, `bufferedRecords`,
`droppedRecords`, the counters since start `receivedRecords` (records taken
from stream frames), `writtenFacts` and `writtenSnapshots` (rows newly stored),
`duplicateRecords` (records the store already had), `lastWriteAtMs` (last
stored batch of records) and `lastWriteError` when the last flush failed. The stream
state SHALL NOT change `ok` or the HTTP status of `/health`. Recorder events
SHALL contain no secrets and no record payloads.

#### Scenario: Disconnected stream keeps health status
- **WHEN** the recorder is in `backoff` and the entry package path is ready
- **THEN** `/health` answers 200 with `ok: true` and `exchangeStream.state` `backoff`

#### Scenario: Health tells a quiet stream from a failing store
- **WHEN** the stream delivered order and wallet frames and the store wrote them
- **THEN** `receivedRecords`, `writtenFacts` and `writtenSnapshots` grow, `lastWriteAtMs` is set and `lastWriteError` is absent
- **AND** with no frames at all every counter stays 0 and `lastMessageAtMs` and `lastWriteAtMs` are absent

### Requirement: Health reports the exchange order linker
`GET /health` SHALL include `exchangeLinker` with `state` (`disabled`,
`waiting_for_correlation`, `running`, `stopped`), the disabled `reason` when
disabled, `lastTickAtMs`, `linksWritten`, `waitingOrders`
(count per reason), `notLinkableOrders` (count per reason) and `lastError` when the last tick
failed. The linker state SHALL NOT change `ok` or the HTTP status of
`/health`. Linker events SHALL contain no secrets and no record payloads.

#### Scenario: Linker error keeps health status
- **WHEN** the last linker tick failed and the entry package path is ready
- **THEN** `/health` answers 200 with `ok: true` and `exchangeLinker.lastError` set

### Requirement: Health reports REST reconciliation and completeness
`GET /health` SHALL include `exchangeRest` with `state` (`disabled`,
`backfilling`, `idle`, `fetching`, `stopped`), the disabled `reason`,
`coveredFromMs`, `backfillDone`, `queueWindows`, `requests`,
`recordsFetched`, `recordsNew`, `lastSweepAtMs` and `lastError`, and
`exchangeCompleteness` with `checkedAtMs`, `execMismatchOrders`,
`uncoveredGaps`, `closedCyclesWithoutCloseFill` and `unlabeledRestOrders`.
They SHALL NOT change `ok` or the HTTP status. Events SHALL contain no
secrets and no record payloads.

#### Scenario: Backfill running
- **WHEN** the startup backfill is in progress and the entry package path is ready
- **THEN** `/health` answers 200 with `ok: true` and `exchangeRest.state` `backfilling`
