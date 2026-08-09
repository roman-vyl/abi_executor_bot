## Purpose

Gives Abi's process output a stable, machine-readable operational-event shape so future collectors and diagnostics tooling can consume it without parsing free-text log lines.

## ADDED Requirements

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
