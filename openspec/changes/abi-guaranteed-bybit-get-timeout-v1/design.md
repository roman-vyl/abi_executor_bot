## Context

Audited revision: b65b399. RestBybitAdapter.readWithRetry awaits a callback using AbortSignal.timeout; the callback awaits fetch and readBybitResponse. A transport that ignores cancellation can keep that callback pending. KeyedMutex releases through ordinary Promise settlement. This change addresses that GET boundary only.

open_position reads its own fills, attributed protection and position, and can also save first_fill_at_ms or terminal_closed to the JSONL correlation store. Wrapping the whole handler in a timeout would allow a late business continuation or durable write and is excluded.

## Goals / Non-Goals

Guarantee completion of each GET attempt when the event loop can process timers, and prevent an expired attempt from supplying evidence to the application. Keep the current GET retry count, signing, pool, configuration and HTTP contracts. No operation executor, operation-wide deadline, owner transfer, mutex change, filesystem timeout, POST change or recovery change.

## Decisions

1. Own the timeout at the GET exchange boundary. Use one attempt-local timer and AbortController, with an idempotent settlement state and monotonic expiry checks. The timer both marks the attempt expired and rejects the awaited result; aborting the transport alone is insufficient. Begin the timer before dispatch, covering pool/connection wait, headers and the response body. Timer delivery requires a running event loop; synchronous CPU work, process suspension and kernel scheduling cannot be forcibly preempted by this mechanism.
2. Keep one immediate retry for the existing timeout and connection-break classes, with a fresh controller, timer and signed timestamp for each attempt. Preserve defaults and positive-integer validation. Non-retryable failures remain non-retryable. A small GET-only helper is permitted; do not create a generic operation scheduler or wrap trading POSTs.
3. Explicitly guard the asynchronous boundaries before processing a response and after body completion, before parsing or publishing evidence. A fetch that resolves after expiry must not start body consumption. A body read already in progress is aborted; if it ignores abort and resolves later, its content must not be parsed or returned. Check expiry before and after synchronous decode as well; it cannot be interrupted midway. Only an active attempt can settle successfully. Do not allow a late success from the first attempt to override the retry or a terminal failure.
4. Request best-effort cancellation of an expired response body without awaiting cancellation as a new blocking dependency. Attach rejection handlers to abandoned fetch/body/cancel Promises, including a late response. Clear the attempt timer on settlement and detach owned listeners. Timeout must not destroy the shared Agent or interrupt other operations. Ignoring abort may leave an underlying GET alive; isolation guarantees its result cannot reach business continuations or durable writes, not that arbitrary uncooperative code is forcibly terminated.
5. Preserve ordinary per-trade serialization. Only the protected operation's normal completion/rejection releases its key. Integration tests must demonstrate failure and a fresh next lookup through real service/mutex components; neither manual key deletion nor simulated lock expiry is permitted. Do not claim a three-second bound for an entire open_position that can perform several independent GETs, confirmations and bounded history pages.
6. Keep the application outside an expired request callback. The late transport callback may only clean up resources; it must not call the service, save correlation state or execute a command. Tests must release deferred results after the retry and after the next lookup and verify unchanged returned results, correlation records and command counts.

## Risks / Trade-offs

- An uncooperative underlying GET may outlive its caller. Abort plus guarded evidence isolation is the safety boundary. No POST enters this path.
- Timeout versus success races can accidentally start a third attempt or accept expired data. Use idempotent settlement and deterministic timer tests at both sides of the deadline.
- A throwing, rejecting or never-settling body cancellation must not delay the returned timeout or create unhandled rejections.
- Existing GET consumers sometimes map failed reads into typed outcomes or try another source. Preserve those existing mappings in this GET-only step. Exhaustion rejects the individual GET; it does not introduce a universal immediate HTTP internal_error for every nested read. The lock-release regression uses the required position GET, whose current mapping already fails the lookup. GET settlement and complete HTTP-operation settlement are separate assertions.
- JSONL append/fsync hangs remain possible and outside this step. No claim of recovery from those failures or automatic process restart is made.

## Migration Plan

The reviewed implementation remains on an isolated branch, with fake/localhost tests and repository checks complete. Deployment requires separate approval. No production probe, trading smoke or restart is needed to validate this contract. Rollback of a later deployment would restore the previous GET implementation and its known waiting gap; it would not change persisted data formats.
