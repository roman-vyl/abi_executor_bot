## Context

See proposal.md - Why. Current emission points: two `console.log` calls in `src/app/index.ts` (start banner + pretty-printed config), one in `src/app/server.ts` (listen callback), two `logger.log`/`logger.error` calls in `src/app/shutdown.ts` (injected as `LoggerLike`, defaults to `console`), and no logging at all inside the four execution operation call paths (`entryPackageApplicationService`, `openPositionResolutionService`, `protectionApplicationService`, `closeApplicationService`). No logger library is installed.

## Goals / Non-Goals

**Goals:**
- One small, shared emission helper used by all call sites in this change, so envelope shape (`timestamp`/`level`/`service`/`event`) and stream routing are enforced in one place, not per call site.
- Minimal surface: a function to build+write an event, not a logger abstraction with levels/transports/formatters.

**Non-Goals:**
- No logger library adoption (pino/winston/bunyan) — a few `JSON.stringify` + `process.stdout.write`/`process.stderr.write` calls suffice at this call-site count.
- No enforcement mechanism (lint rule, CI check) banning future raw `console.log` — out of scope for this change; can be a later follow-up if drift becomes a problem.
- No change to `shutdown.ts`'s `LoggerLike` injection seam beyond swapping what it's given to call — its testability contract stays.

## Decisions

**Single `emitEvent` helper, not a class-based logger.**
A function `emitEvent(level, service, event, fields?)` that builds the envelope, `JSON.stringify`s it as one line, and writes to `process.stdout` or `process.stderr` based on `level`. Alternative considered: adopt pino now. Rejected — pino brings transport/config surface this change's scope explicitly excludes (no collector, no persistence), and two call sites plus four operation sites don't justify a dependency; can be swapped in later behind the same helper's call sites without touching specs.

**Location: `src/observability/events.ts`.**
New small module, sibling to existing top-level concern directories (`src/domain`, `src/risk`, `src/execution`, `src/exchange`, `src/correlation`). Alternative considered: put it under `src/app/` since two of five call-site groups live there. Rejected — the four execution services under `src/services/**` are equally primary consumers; a cross-cutting concern shouldn't live inside `app`.

**Operation timing measured at the call boundary, not inside domain logic.**
`operation_started`/terminal event pairs wrap each application service's public entry method (e.g. `EntryPackageApplicationService.apply(...)`) from the outside — timer starts right before the call, terminal event fires in a `try/finally`-style wrapper around it. Alternative considered: instrument inside each service's internal steps for finer-grained timing. Rejected — proposal scope is one `operation_started`/terminal pair per invocation, not sub-step tracing (that's explicitly Level 2/`trace_id` territory, a stated non-goal).

**`strategy_instance_id`/`trade_cycle_id` sourced from existing request/domain data, not new fields threaded in.**
These operations already receive Runtime-supplied identifiers (entry-package requests, trade-cycle-scoped calls) as part of their existing input contracts. The emission wrapper reads them from the same input object already being passed in; no new parameter plumbing through unrelated layers.

**`outcome` values are a fixed vocabulary defined alongside the four operations, not a free string.**
Each operation's terminal event picks `outcome` from a small enum specific to that operation (e.g. entry_package: `entry_package_applied` | `entry_package_absent` | ...). Prevents outcome-string drift across call sites while keeping `event` itself small (`operation_completed`/`operation_failed` only).

## Risks / Trade-offs

- [Wrapping four service entry points touches production call paths for a purely observational change] → Wrap at the outermost public method only (timer + emit around the existing call), no change to internal control flow, error types, or return values; `npm test` and `npm run typecheck` must pass unchanged aside from new event-emission assertions.
- [`outcome` vocabulary could still drift per-operation if not centrally typed] → Define outcome literal unions per operation in `src/observability/events.ts` (or co-located per service) so TypeScript catches an invalid outcome string at the call site.
- [Existing `shutdown.ts` `LoggerLike` seam is test-injected — swapping its calls to `emitEvent` must not break existing shutdown tests] → Keep the injection seam; either pass an adapter satisfying `LoggerLike` that internally calls `emitEvent`, or extend the test double alongside the production change, whichever existing shutdown tests require with least churn.
