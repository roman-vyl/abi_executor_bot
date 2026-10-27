## Context

`RestBybitAdapter` sends every Bybit request through `fetch` with `AbortSignal.timeout(bybitRequestTimeoutMs)` (10 s). GET reads go through `signedGet` and three public read methods; writes go through `signedPost`. Diagnostics show the 10 s aborts are single stuck reads that a fresh request answers at once.

## Decisions

### D1. Read timeout applies to GET only
A new config value `bybitReadTimeoutMs` (`ABI_BYBIT_READ_TIMEOUT_MS`, positive integer, default `1500`, invalid value fails startup like the other timeouts) is used for every GET the adapter sends. `bybitRequestTimeoutMs` stays for POST only.

### D2. One immediate retry on timeout only
A GET attempt that ends with an error named `TimeoutError` (the `AbortSignal.timeout` abort, whether it fires while waiting for headers or reading the body) is repeated once, at once, with a new signal of the same length. Errors of any other kind are thrown on the first attempt. The second attempt's result or error is returned as is.

### D3. Fresh signature per attempt
A signed GET computes `X-BAPI-TIMESTAMP` and `X-BAPI-SIGN` inside each attempt, so the repeat is not rejected by `recv_window`.

### D4. Retry lives in the adapter
The retry wraps only the HTTP request inside `RestBybitAdapter`. Callers (services, providers, decoders) see the same method signatures and the same error kinds as before; no service code changes.

### D5. Diagnostics
Each attempt is wrapped in `timeBybitRequest`, so with `ABI_DIAGNOSTICS_PATH` set the file shows a cut attempt (`TimeoutError`, ≈1500 ms) followed by the repeat. This is how the effect is measured after deploy.

## Risks

- Paged reads (order history windows, execution list) make the same number of pages; each page is bounded by 3 s instead of 10 s.
- If Bybit Demo becomes uniformly slow (all reads > 1.5 s), reads fail where they used to succeed late. Mitigation: `ABI_BYBIT_READ_TIMEOUT_MS` can be raised without a code change.
