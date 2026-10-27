## 1. abi_executor_bot

- [x] 1.1 Config `ABI_BYBIT_READ_TIMEOUT_MS` (default `1500`, positive integer, invalid fails startup); test fixture; README row.
- [x] 1.2 `RestBybitAdapter`: all GET requests (signed and public) use the read timeout through one private helper that repeats the request once on `TimeoutError`; signed GET signs each attempt; POST keeps `bybitRequestTimeoutMs` and no retry; each attempt wrapped in `timeBybitRequest`.
- [x] 1.3 Tests with a scripted `fetch`: hang then answer → answer returned after two calls; hang twice → `TimeoutError` after exactly two calls; non-timeout failure → one call; each signed attempt has its own timestamp and signal; public GET retried the same way; POST failing is not retried; POST slower than the read timeout is not cut; config default and override.
- [x] 1.4 `npm test`, `npm run typecheck`, `openspec validate --strict`.

## 2. Rollout (on owner's word only)

- [ ] 2.1 PR, review, merge on the owner's word.
- [ ] 2.2 `bbb_stack` pin and deploy on the owner's word (no new env needed: the default is 1500).
- [ ] 2.3 After ~11 h on demo: compare with the 2026-10-26/27 window: open-position lookups over 5 s, `internal_error` count, Runtime bars skipped for ABI.
