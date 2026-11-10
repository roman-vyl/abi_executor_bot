## 1. GET attempt boundary

- [x] 1.1 Add a focused GET-only attempt boundary that independently settles at the configured timeout, aborts the transport, and covers dispatch/pool wait, headers and body consumption.
- [x] 1.2 Guard response/body/parse/result boundaries against expiry; observe late rejections, perform nonblocking best-effort body cancellation, and clean up timers and owned listeners.
- [x] 1.3 Integrate every public and signed REST GET with the existing one-retry policy, fresh signing and existing failure mappings. Keep POST, mutex, correlation writes, startup and configuration unchanged.

## 2. Deterministic and localhost regression tests

- [x] 2.1 Test a fetch Promise that ignores abort forever: first expiry starts one retry, second expiry rejects, no third attempt or lingering attempt timer is created.
- [x] 2.2 Test late fetch success/rejection and late body completion before/after retry success/failure: no late parsing, answer replacement, durable mutation, command or unhandled rejection.
- [x] 2.3 Test timeout/success boundary races and body-cancel throw/rejection/nonsettlement; ensure one winner and no cleanup dependency can extend the attempt.
- [x] 2.4 Test localhost header stall, body stall and pool wait with the supported Node/Undici versions; preserve normal response, error classification, connection-break retry, signing and shared-pool behavior.
- [x] 2.5 Exercise the real open-position service and per-trade mutex with an exhausted required position GET: existing HTTP failure, normal key release, then a fresh successful lookup. Resolve both older attempts afterwards and assert unchanged answers, correlation records and zero trading commands.
- [x] 2.6 Retain POST single-attempt/long-timeout tests and verify no GET timeout helper is reachable from a trading POST.

## 3. Validation and review

- [x] 3.1 Run focused tests, npm test, npm run typecheck and OpenSpec strict validation. Record supported runtime versions and any independently reproduced baseline failures.
- [x] 3.2 Review the diff for only GET implementation/tests and these artifacts. No production commands, trading smoke, deployment or restart. Request separate approval for any later deployment.

## Validation result

Full unit suite on Node 24.18.0: 1174/1174 passed. Targeted GET, retry, keepalive/POST and real open-position service/mutex tests on Node 20.20.2 with Undici 6.24.1: 75/75 passed. TypeScript, OpenAPI (5 documents/11 operations), strict OpenSpec validation and whitespace checks passed. All network tests use scripted fetch or localhost. No production commands, external Bybit calls, trading actions, deployment or restart were performed during implementation.
