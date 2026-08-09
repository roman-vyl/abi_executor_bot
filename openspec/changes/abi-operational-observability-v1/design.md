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

**Operation timing measured at the instrumentation boundary, not inside domain logic.**
`operation_started` fires only once the invocation is a successfully decoded application operation (after transport/command decode, before the service's core logic runs) — a transport-level decode rejection never reaches `operation_started`, so it never gets fabricated `strategy_instance_id`/`trade_cycle_id`. The terminal event fires via a `try/catch`-style wrapper, not bare `finally`: a normal return (including a handled business-negative typed result) takes the `operation_completed` branch; a thrown/rejected exception takes the `operation_failed` branch. If the process never reaches either branch (hang, crash, kill), no terminal event is emitted — that absence is itself the diagnostic signal, not a bug to engineer around. Alternative considered: instrument inside each service's internal steps for finer-grained timing. Rejected — proposal scope is one `operation_started`/terminal pair per invocation, not sub-step tracing (Level 2/`trace_id` territory, a stated non-goal).

**`strategy_instance_id`/`trade_cycle_id` are required on both `operation_started` and the terminal event, sourced from the already-decoded input.**
Because `operation_started` only fires after successful decode, the identifiers are always present on the decoded input by that point — no "where available" branch, no fabricated placeholder values for pre-decode rejections (those never reach `operation_started` at all). The emission wrapper reads them from the same input object already being passed in; no new parameter plumbing through unrelated layers.

**`operation_completed` vs `operation_failed` is decided by normal-return vs thrown/rejected, not by business polarity.**
A handled business-negative result (`position_not_open`, `unknown_trade_cycle_binding`, `unsupported_exchange_scope`, etc.) is still a normal typed return from the service and takes `operation_completed` at `level: "info"`. Only an unexpected thrown exception or rejected promise reaching the instrumentation boundary takes `operation_failed` at `level: "error"`, with `outcome: "internal_error"`. This keeps `error`-level output meaningful (unexpected failures only) rather than noisy with every anticipated business-negative case.

**`outcome` values are typed unions derived from each operation's existing production result/status/error types, not a new parallel vocabulary.**
Each operation's terminal event picks `outcome` from a union derived directly from that operation's existing result type (e.g. entry_package's existing applied/absent result, `open_position`'s existing boolean success mapped to `position_open` | `position_closed`, plus `internal_error` shared across all four for the thrown/rejected branch). No new business-outcome taxonomy is invented for observability — this is a re-labeling of what the code already returns/throws, typed so an invalid outcome string fails to compile.

## Risks / Trade-offs

- [Wrapping four service entry points touches production call paths for a purely observational change] → Wrap at the outermost public method only (timer + emit around the existing call), no change to internal control flow, error types, or return values; `npm test` and `npm run typecheck` must pass unchanged aside from new event-emission assertions.
- [`outcome` vocabulary could still drift per-operation if not centrally typed] → Define outcome literal unions per operation in `src/observability/events.ts` (or co-located per service) so TypeScript catches an invalid outcome string at the call site.
- [Existing `shutdown.ts` `LoggerLike` seam is test-injected — swapping its calls to `emitEvent` must not break existing shutdown tests] → Keep the injection seam; either pass an adapter satisfying `LoggerLike` that internally calls `emitEvent`, or extend the test double alongside the production change, whichever existing shutdown tests require with least churn.
