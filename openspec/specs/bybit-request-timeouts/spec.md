# bybit-request-timeouts Specification

## Purpose
How long ABI waits for Bybit: read-only GET requests use a short timeout with one immediate retry on timeout, order-writing POST requests keep the long timeout and are never repeated.
## Requirements
### Requirement: Bybit read requests use a short timeout with one retry on timeout
ABI SHALL send every Bybit GET request (signed or public) with a timeout of
`ABI_BYBIT_READ_TIMEOUT_MS` milliseconds, default `1500`. When a GET request
ends because that timeout fired, or because an established connection broke
(the fetch failure's cause code is `UND_ERR_SOCKET`, `ECONNRESET` or `EPIPE`),
ABI SHALL repeat the same request once, immediately, with the same timeout.
ABI SHALL NOT repeat a GET request that failed for any other reason, and SHALL
NOT send more than two attempts of one GET request. When the repeat fails, ABI
SHALL handle its error exactly as it handles a failed read without this rule.
A signed GET SHALL be signed again with a fresh timestamp for the repeat.

#### Scenario: A hung read is recovered by the repeat
- **WHEN** a Bybit GET request does not answer within the read timeout
- **AND** the immediate repeat answers within the read timeout
- **THEN** ABI uses the repeat's answer
- **AND** exactly two requests were sent

#### Scenario: A read on a broken connection is recovered by the repeat
- **WHEN** a Bybit GET request fails because the connection was closed by the other side or reset
- **AND** the immediate repeat answers
- **THEN** ABI uses the repeat's answer
- **AND** exactly two requests were sent

#### Scenario: A read that hangs twice fails as before
- **WHEN** a Bybit GET request and its repeat both time out
- **THEN** ABI sends no third request
- **AND** the caller receives the timeout failure through the existing error path

#### Scenario: A read that fails twice on a timeout or a connection break fails as before
- **WHEN** a Bybit GET request and its repeat both fail with a timeout or a connection break, in any combination
- **THEN** ABI sends no third request
- **AND** the caller receives the second failure through the existing error path

#### Scenario: A non-timeout read failure is not repeated
- **WHEN** a Bybit GET request fails with an HTTP error status (403 included), a Bybit error code, a DNS error, a refused connection or any other fetch error that is neither a timeout nor a connection break
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
request for any reason, including a connection break.

#### Scenario: A failed order write is not repeated
- **WHEN** a Bybit POST request fails or times out
- **THEN** ABI sends no repeat

#### Scenario: An order write on a broken connection is not repeated
- **WHEN** a Bybit POST request fails because the connection was closed by the other side or reset
- **THEN** ABI sends no repeat
- **AND** the caller receives the failure through the existing error path

#### Scenario: A slow order write is not cut by the read timeout
- **WHEN** a Bybit POST request answers after longer than the read timeout but within `ABI_BYBIT_REQUEST_TIMEOUT_MS`
- **THEN** ABI uses that answer

