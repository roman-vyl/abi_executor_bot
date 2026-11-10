## Why

A Bybit GET can leave a trade operation waiting indefinitely if its Promise does not settle after its AbortSignal fires. The per-trade mutex then correctly keeps subsequent operations behind that unfinished caller. This proposal closes the GET waiting gap; it does not claim to establish the cause of the November 9 incident.

## What Changes

- Make the existing per-attempt GET timeout settle the adapter's returned Promise independently of transport cooperation, covering connection/pool wait, response headers and response-body consumption.
- Keep `ABI_BYBIT_READ_TIMEOUT_MS=1500` by default, exactly one immediate retry for timeout or the existing connection-break cases, and fresh signing for the retry.
- Abort an expired attempt and isolate its late completion: do not consume or parse a late response, return it to a caller, persist it, or turn it into a trading decision. Observe late rejections and release timers/listeners.
- Preserve existing failed-read mappings. Verify that an exhausted GET on an open-position failure path finishes the operation and releases its ordinary mutex; the next request performs fresh reads.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `bybit-request-timeouts`: guaranteed settlement of a GET attempt and isolation of expired results while retaining the existing retry policy.

## Impact

Implementation is limited to the REST adapter's GET boundary, a focused GET-only helper if needed, and isolated tests. No new dependency, configuration or HTTP shape is required. It applies to existing public and signed GET reads in every configured environment. Dry-run and live authorization/guard behavior stay unchanged.

Non-goals: changing mutex/queue policy, JSONL or SQLite journals, trading POST execution or retries, startup reconciliation, operation-wide budgets, ownership generations, process restart, deployment, or Runtime/MDS. Existing trade serialization and durable-write ordering are preserved. A hung fsync remains outside this change.
