## 1. Event Emission Helper

- [ ] 1.1 Create `src/observability/events.ts` with `emitEvent(level, event, fields?)`: builds the base envelope (`timestamp`, `level`, `service: "abi_executor_bot"`, `event`, plus `fields`), serializes as one single-line JSON string, writes to `process.stdout` for `level: "info" | "warn"` and `process.stderr` for `level: "error"`.
- [ ] 1.2 Type `level` as the literal union `"info" | "warn" | "error"` — no other value compiles.
- [ ] 1.3 Add unit tests: envelope shape, single-line JSON output, stdout routing for info/warn, stderr routing for error.

## 2. Lifecycle Events

- [ ] 2.1 In `src/app/index.ts`, replace the two `console.log` calls (start banner + pretty-printed config dump) with one `service_starting` event via `emitEvent`, carrying the same config fields as structured `fields` (not a nested pretty-printed object).
- [ ] 2.2 In `src/app/server.ts`, replace the `server.listen` callback's `console.log` with a `server_listening` event.
- [ ] 2.3 In `src/app/server.ts`, wrap the `correlationRepository.replay()` chain with `correlation_replay_started` before the call, `correlation_replay_succeeded` on the `result.ok` branch, `correlation_replay_failed` on the failure/catch branches.
- [ ] 2.4 In `src/app/server.ts`, emit `readiness_ready` alongside `readiness.markReady()` and `readiness_failed` alongside `readiness.markNotReady(...)`.
- [ ] 2.5 In `src/app/shutdown.ts`, replace the `logger.log`/`logger.error` calls with `shutdown_started`, `shutdown_completed`, `shutdown_failed` events via `emitEvent`, preserving existing control flow and exit codes; adjust or extend the `LoggerLike` injection seam only as needed to keep existing shutdown tests passing.
- [ ] 2.6 Add/update tests covering: replay success emits `correlation_replay_started` → `correlation_replay_succeeded` → `readiness_ready`; replay failure emits `correlation_replay_started` → `correlation_replay_failed` → `readiness_failed`; shutdown success emits `shutdown_started` → `shutdown_completed` with exit code 0; shutdown failure emits `shutdown_started` → `shutdown_failed` with exit code 1.

## 3. Execution Operation Events

- [ ] 3.1 Define per-operation `outcome` literal unions (entry_package, open_position, protection, close_position) in `src/observability/events.ts` or co-located with each service, per design.md.
- [ ] 3.2 Wrap `EntryPackageApplicationService`'s public entry method: emit `operation_started` with `operation: "entry_package"` before the call; emit exactly one terminal event (`operation_completed` or `operation_failed`) with `operation`, `outcome`, `duration_ms`, and `strategy_instance_id`/`trade_cycle_id` where available.
- [ ] 3.3 Apply the same wrapping to `OpenPositionResolutionService` (`operation: "open_position"`).
- [ ] 3.4 Apply the same wrapping to `ProtectionApplicationService` (`operation: "protection"`).
- [ ] 3.5 Apply the same wrapping to `CloseApplicationService` (`operation: "close_position"`).
- [ ] 3.6 Add unit tests per operation: success path emits `operation_started` then exactly one `operation_completed` with correct `outcome`; failure path emits `operation_started` then exactly one `operation_failed`, and never both terminal events for one invocation.

## 4. Sensitive Data Exclusion Verification

- [ ] 4.1 Review every new `emitEvent` call site (lifecycle + execution) to confirm no field carries the Bybit API key/secret or raw request/response payloads.
- [ ] 4.2 Add a test asserting the `service_starting` event's config fields exclude the raw API key value (mirroring the existing `bybitApiKeyConfigured` boolean approach already used in the old config dump).

## 5. Validation

- [ ] 5.1 Run `npm test`.
- [ ] 5.2 Run `npm run typecheck`.
- [ ] 5.3 Manually start the service (dry-run config) and confirm stdout/stderr output is single-line JSON only, with no remaining pretty-printed or bare-text log lines.
