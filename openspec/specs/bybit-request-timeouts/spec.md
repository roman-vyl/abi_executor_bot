# bybit-request-timeouts Specification

## Purpose
How long ABI waits for Bybit: read-only GET requests use a short timeout with one immediate retry on timeout, order-writing POST requests keep the long timeout and are never repeated.
## Requirements
### Requirement: Bybit read requests use a short timeout with one retry on timeout
ABI SHALL send every Bybit GET request (signed or public) with a timeout of
`ABI_BYBIT_READ_TIMEOUT_MS` milliseconds, default `1500`. When a GET request
ends because that timeout fired, ABI SHALL repeat the same request once,
immediately, with the same timeout. ABI SHALL NOT repeat a GET request that
failed for any other reason. When the repeat fails, ABI SHALL handle its error
exactly as it handles a failed read without this rule. A signed GET SHALL be
signed again with a fresh timestamp for the repeat.

#### Scenario: A hung read is recovered by the repeat
- **WHEN** a Bybit GET request does not answer within the read timeout
- **AND** the immediate repeat answers within the read timeout
- **THEN** ABI uses the repeat's answer
- **AND** exactly two requests were sent

#### Scenario: A read that hangs twice fails as before
- **WHEN** a Bybit GET request and its repeat both time out
- **THEN** ABI sends no third request
- **AND** the caller receives the timeout failure through the existing error path

#### Scenario: A non-timeout read failure is not repeated
- **WHEN** a Bybit GET request fails with a network error, an HTTP error status or a Bybit error code
- **THEN** ABI sends no repeat

#### Scenario: Read timeout is configurable
- **WHEN** `ABI_BYBIT_READ_TIMEOUT_MS` is unset
- **THEN** the read timeout is 1500 ms
- **WHEN** it is set to a positive integer
- **THEN** that value is used
- **WHEN** it is present but not a positive integer
- **THEN** startup fails

### Requirement: Bybit write requests keep their timeout and are never repeated
ABI SHALL send every Bybit POST request with the timeout
`ABI_BYBIT_REQUEST_TIMEOUT_MS` (default `10000`) and SHALL NOT repeat a POST
request for any reason.

#### Scenario: A failed order write is not repeated
- **WHEN** a Bybit POST request fails or times out
- **THEN** ABI sends no repeat

#### Scenario: A slow order write is not cut by the read timeout
- **WHEN** a Bybit POST request answers after longer than the read timeout but within `ABI_BYBIT_REQUEST_TIMEOUT_MS`
- **THEN** ABI uses that answer

