## Why

Real Bybit Demo smoke proved entry-package execution, position confirmation, and initial SL/TP all
work end to end. Runtime then called `PUT .../protection` with the same stop/take already sitting on
Bybit from entry-package's own initial write. `ProtectionApplicationService` always sends an
unconditional `setTradingStop` write before comparing anything; Bybit rejected the redundant write as
not-modified, and ABI surfaced that as `internal_error` even though the desired protection state was
already true on the exchange.

## What Changes

- Before writing, compare the desired `stop_price`/`take_price` against the exchange's already-
  confirmed protection (read from the same live-position query the existing live-position gate already
  performs — no second query). If numerically equal (exact-decimal, same semantics the read-back
  already uses), skip the write entirely and return `protection_applied` directly. Otherwise, run the
  existing write + bounded read-back unchanged.
- The live-execution guard still applies on the already-satisfied path: if live execution is not
  permitted, ABI fails closed exactly as it does today, even when the desired state already matches.
- No retCode-specific handling of Bybit's not-modified response; the desired-state comparison happens
  entirely before any write is attempted.

Non-goals: no idempotency framework, command IDs, write retries, new correlation statuses, new
persistence, or Bybit-specific error handling. No change to Runtime, Engine, MDS, or bbb_stack. No
change to entry-package's own initial SL/TP behavior.

## Capabilities

### Modified Capabilities
- `protection-execution`: success no longer requires a live write on every request — an already-
  satisfied desired state is a second, equally valid success path that performs zero exchange writes.
- `abi-position-management-api`: documents that an already-matching confirmed protection may return
  `protection_applied` without an exchange mutation. No change to route, request/response DTOs, status
  codes, or error vocabulary.

## Impact

- `src/services/protection/protectionApplicationService.ts`: adds a pre-write equality decision using
  the existing exact-decimal comparison and existing read-back matching semantics.
- `src/services/openPosition/openPositionResolutionService.ts`: the internal `PositionDetermination`
  for `kind: "open"` carries the confirmed stop-loss/take-profit already present on the row it already
  queries, so the comparison needs no additional Bybit call. No change to the public `GET
  .../open-position` response shape.
- Public HTTP contract, correlation store, and OpenAPI schema: unchanged.
