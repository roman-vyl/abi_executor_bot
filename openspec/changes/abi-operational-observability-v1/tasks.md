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

- [ ] 3.1 Define per-operation `outcome` literal unions derived from each operation's existing production result/status/error types (entry_package, open_position, protection, close_position), plus the shared `internal_error` outcome, in `src/observability/events.ts` or co-located with each service, per design.md. For `open_position`, derive `position_open` | `position_closed` from the existing boolean success result — do not invent a separate business-outcome taxonomy.
- [ ] 3.2 Wrap `EntryPackageApplicationService`'s public entry method at the instrumentation boundary (after successful transport/command decode, before core logic runs): emit `operation_started` with `operation: "entry_package"`, `strategy_instance_id`, and `trade_cycle_id` (required, always present post-decode). Classify the terminal event by resulting `outcome`, not by resolve/reject alone: a normal return whose `outcome` is a handled business-negative result (`position_not_open` / `unknown_trade_cycle_binding` / `unsupported_exchange_scope` where applicable to this operation) emits exactly one `operation_completed` (`level: "info"`); a normal return whose `outcome` is `internal_error` (the service caught its own exception and returned a typed `internal_error` result) emits exactly one `operation_failed` (`level: "error"`, `outcome: "internal_error"`); an uncaught thrown/rejected exception reaching the boundary likewise emits exactly one `operation_failed` (`level: "error"`, `outcome: "internal_error"`). All terminal events carry `operation`, `outcome`, `duration_ms`, `strategy_instance_id`, `trade_cycle_id`. Do not change the service's existing exception-to-typed-`internal_error` handling or any other behavior — instrumentation only classifies what already comes back. A transport-level decode rejection before this boundary is not a started operation and emits no `operation_started`.
- [ ] 3.3 Apply the same wrapping to `OpenPositionResolutionService` (`operation: "open_position"`, outcomes `position_open` | `position_closed` | `internal_error`).
- [ ] 3.4 Apply the same wrapping to `ProtectionApplicationService` (`operation: "protection"`).
- [ ] 3.5 Apply the same wrapping to `CloseApplicationService` (`operation: "close_position"`).
- [ ] 3.6 Add unit tests per operation: (a) success path emits `operation_started` then exactly one `operation_completed` with correct `outcome`, both `level: "info"`; (b) uncaught thrown/rejected exception at the boundary emits `operation_started` then exactly one `operation_failed` with `outcome: "internal_error"`, `level: "error"`, and no `operation_completed`; (c) a *typed, normally-returned* `internal_error` result (service catches its own exception and resolves, does not throw) is also classified `operation_failed` with `outcome: "internal_error"`, `level: "error"` — proving classification follows `outcome`, not resolve/reject; (d) a handled business-negative typed result emits `operation_completed`, not `operation_failed`; (e) never both `operation_completed` and `operation_failed` for one invocation; (f) `strategy_instance_id`/`trade_cycle_id` present on both `operation_started` and the terminal event; (g) the service's existing exception-to-typed-`internal_error` catch behavior is unchanged by instrumentation (same typed result shape as before this change).

## 4. Sensitive Data Exclusion Verification

- [ ] 4.1 Review every new `emitEvent` call site (lifecycle + execution) to confirm no field carries the Bybit API key/secret or raw request/response payloads.
- [ ] 4.2 Add a test asserting the `service_starting` event's config fields exclude the raw API key value (mirroring the existing `bybitApiKeyConfigured` boolean approach already used in the old config dump).

## 5. Validation

- [ ] 5.1 Run `npm test`.
- [ ] 5.2 Run `npm run typecheck`.
- [ ] 5.3 Run `npm run build`.
- [ ] 5.4 Run `npm run validate:openapi`.
- [ ] 5.5 Run `openspec validate --strict --all`.
- [ ] 5.6 Run `git diff --check`.
- [ ] 5.7 Manually start the service (dry-run config) and confirm stdout/stderr output is single-line JSON only, with no remaining pretty-printed or bare-text log lines.
