## 1. Confirmed-protection plumbing

- [x] 1.1 Extend `OpenPositionResolutionService`'s internal `PositionDetermination` (`kind: "open"`)
      with the confirmed `stopLoss`/`takeProfit` already present on the row it already queries. No
      change to the public `GET .../open-position` response shape.

## 2. Pre-write equality decision

- [x] 2.1 In `ProtectionApplicationService`, after the live-position gate and before the write,
      compare the confirmed protection against the accepted request using the existing exact-decimal
      read-back matching function. If already equal, check the existing live-execution guard and
      either fail closed or return `protection_applied` directly, sending no write. If it differs,
      fall through to the existing write + bounded read-back unchanged.

## 3. Tests

- [x] 3.1 Already-equal both legs: zero writes, `protection_applied`.
- [x] 3.2 Already-equal with differing string formatting: zero writes, response echoes request
      strings.
- [x] 3.3 `take_price: null` already absent (exchange numeric zero): zero writes, `protection_applied`.
- [x] 3.4 Already-equal but live-execution guard disabled: fail closed, zero writes.
- [x] 3.5 A differing leg still sends exactly one write and requires the bounded read-back (existing
      tests updated to exercise the differ path explicitly, since their exchange state no longer
      starts pre-matched).
- [x] 3.6 Existing scenarios unchanged: unknown pair, durably absent, ownership mismatch, no live
      position, unsupported scope.

## 4. Verification

- [x] 4.1 `npm test`, `npm run typecheck`, `npm run build`, `npm run validate:openapi`, `git diff
      --check`.
- [x] 4.2 OpenSpec strict validation.
