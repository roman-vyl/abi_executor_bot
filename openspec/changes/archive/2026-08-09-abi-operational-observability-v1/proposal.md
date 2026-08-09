## Why

Abi currently emits ad hoc, human-readable `console.log` lines (service start banner, a pretty-printed config dump, the listening line, shutdown lines). This is not machine-readable and gives no visibility into per-operation outcomes (entry package, open position, protection, close). A future diagnostics UI will need structured, per-service operational events as its raw material; fixing the emission shape now, while call sites are few, avoids reworking every log line later plus retrofitting a parser for free-text messages like `"Protection applied successfully for BTC"`.

## What Changes

- Every operational log line becomes exactly one single-line JSON object (no pretty-printed multi-line JSON, no bare text lines).
- New base envelope on every event: `timestamp`, `level` (`info | warn | error` only), `service` (fixed literal `"abi_executor_bot"`), `event`.
- Stream routing: `level=error` → stderr; `level=info` and `level=warn` → stdout.
- Lifecycle events added at existing lifecycle points: `service_starting`, `server_listening`, `correlation_replay_started`, `correlation_replay_succeeded`, `correlation_replay_failed`, `readiness_ready`, `readiness_failed`, `shutdown_started`, `shutdown_completed`, `shutdown_failed`. `shutdown_failed` structures the existing `server.close()` error branch that already logs and exits `1` — not new behavior, just structured.
- Execution operation events added around the four Runtime-facing operations (`entry_package`, `open_position`, `protection`, `close_position`): `operation_started` always emitted first, followed by exactly one terminal event (`operation_completed` or `operation_failed`). Terminal events carry `outcome` and `duration_ms`.
- `outcome` carries the specific result (e.g. `entry_package_applied`, `position_open`, `protection_applied`, `trade_cycle_closed`) instead of growing the `event` vocabulary per result.
- No secrets or raw/sensitive exchange request/response payloads in any event field.

**BREAKING**: none — this is process stdout/stderr output shape only, no HTTP contract, request/response schema, or trading behavior changes.

## Capabilities

### New Capabilities
- `abi-operational-observability`: structured JSON-line operational event emission (envelope, lifecycle events, execution operation events, sensitive-data exclusion) for the Abi process's stdout/stderr.

### Modified Capabilities
(none — existing execution/lifecycle specs describe behavior and HTTP contracts, which are unchanged; this only adds observability emission alongside them)

## Impact

- `src/app/index.ts`: replace the two `console.log` calls (start banner + pretty-printed config dump) with a single `service_starting` structured event.
- `src/app/server.ts`: replace the `server.listen` callback's `console.log` with `server_listening`; add `correlation_replay_started` / `correlation_replay_succeeded` / `correlation_replay_failed` around the existing `correlationRepository.replay()` chain; add `readiness_ready` / `readiness_failed` at the same points.
- `src/app/shutdown.ts`: replace `logger.log`/`logger.error` calls with `shutdown_started`, `shutdown_completed`, `shutdown_failed` structured events (same control flow, same exit codes).
- `src/services/entryPackage/entryPackageApplicationService.ts`, `src/services/openPosition/openPositionResolutionService.ts`, `src/services/protection/protectionApplicationService.ts`, `src/services/close/closeApplicationService.ts`: each gains `operation_started` at entry and exactly one terminal `operation_completed`/`operation_failed` per invocation, carrying `operation`, `strategy_instance_id`, `trade_cycle_id`, `outcome`, `duration_ms`.
- New small internal event-emission helper (single-line JSON serialization + stream routing) — introduced under `src/observability` or similar; exact location is a design.md decision, not a proposal-level one.
- No changes to HTTP routes, request/response bodies, correlation-store record shape, dry-run/live-guard logic, or existing specs' documented behavior.
- Non-goals (explicitly out of scope for this change): frontend, diagnostics HTTP API, persistence/log storage, collector, OpenTelemetry, distributed tracing, `trace_id`, metrics system, request/response body logging, trading behavior changes, command IDs, changes to existing HTTP contracts.
