## Purpose

Gives Abi's process output a stable, machine-readable operational-event shape so future collectors and diagnostics tooling can consume it without parsing free-text log lines.

## ADDED Requirements

### Requirement: Structured Event Envelope
Every operational log line the Abi process writes SHALL be exactly one single-line JSON object (no multi-line pretty-printed JSON, no bare/free-text lines). Each event SHALL include the base envelope fields `timestamp`, `level`, `service`, and `event`. `level` SHALL be exactly one of `info`, `warn`, or `error` — no other value is permitted. `service` SHALL be the fixed literal `"abi_executor_bot"`. Events with `level=error` SHALL be written to stderr; events with `level=info` or `level=warn` SHALL be written to stdout.

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
- **THEN** it emits a `service_starting` event before beginning HTTP server setup

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
For each of the four Runtime-facing execution operations (`entry_package`, `open_position`, `protection`, `close_position`), Abi SHALL emit an `operation_started` event when the operation begins, followed by exactly one terminal event — either `operation_completed` or `operation_failed` — when the operation ends. Every `operation_started` event SHALL be matched by exactly one terminal event for that same invocation; an `operation_started` with no corresponding terminal event is a detectable in-flight/hung-call signal. `operation_started`, `operation_completed`, and `operation_failed` events SHALL include an `operation` field naming which of the four operations it is. Terminal events SHALL include `outcome` and `duration_ms`; `strategy_instance_id` and `trade_cycle_id` SHALL be included on these events where the invocation carries them. `outcome` SHALL carry the specific result of a terminal event (e.g. `entry_package_applied`, `entry_package_absent`, `position_open`, `position_closed`, `protection_applied`, `trade_cycle_closed`) rather than the result being encoded as a distinct `event` value.

#### Scenario: Successful entry package application
- **WHEN** an entry-package operation is invoked and completes successfully
- **THEN** Abi emits `operation_started` with `operation: "entry_package"`, followed by exactly one `operation_completed` event with `operation: "entry_package"`, an `outcome` describing the result, and `duration_ms`

#### Scenario: Failed operation
- **WHEN** any of the four execution operations is invoked and terminates in an error
- **THEN** Abi emits `operation_started` for that operation, followed by exactly one `operation_failed` event with `operation`, `outcome`, and `duration_ms`, and no `operation_completed` event for that same invocation

#### Scenario: Every started event has exactly one terminal event
- **WHEN** any of the four execution operations is invoked
- **THEN** the invocation produces exactly one `operation_started` event and exactly one terminal event (`operation_completed` or `operation_failed`), never zero and never more than one terminal event

### Requirement: Sensitive Data Exclusion
No operational event emitted by Abi SHALL include secrets (API keys, credentials, signing material) or raw/sensitive exchange request or response payloads in any field.

#### Scenario: API key is not logged
- **WHEN** Abi emits any operational event, including lifecycle and execution events referencing exchange configuration
- **THEN** no field contains the raw Bybit API key or secret

#### Scenario: Raw exchange payloads are not logged
- **WHEN** Abi emits an `operation_completed` or `operation_failed` event for an execution operation that involved a Bybit request/response
- **THEN** the event does not include the raw request or response body — only structured fields such as `operation`, `outcome`, identifiers, and `duration_ms`
