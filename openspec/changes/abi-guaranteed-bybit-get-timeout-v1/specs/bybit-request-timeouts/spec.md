## MODIFIED Requirements

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
The per-attempt timeout SHALL settle the returned GET attempt even when the transport ignores cancellation. Its scope SHALL include dispatch/connection or pool wait, response headers and full body consumption. The timeout SHALL apply independently to each attempt; it SHALL NOT impose a new deadline on an entire trade operation. These time guarantees assume the event loop can execute its timers.

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


#### Scenario: Transport ignores cancellation
- **WHEN** the first GET attempt never settles after its timeout signal fires
- **THEN** the awaited attempt rejects at expiry and the one permitted retry starts without waiting for the abandoned attempt
- **AND** if the retry also never settles, the GET rejects after its own timeout and no third attempt starts

#### Scenario: Headers or body never complete
- **WHEN** connection/pool wait, headers, or response-body consumption remains unfinished
- **THEN** the same per-attempt timeout ends the awaited attempt
- **AND** body progress does not reset the total attempt timeout

## ADDED Requirements

### Requirement: Expired GET attempts cannot supply later evidence
An expired GET attempt SHALL NOT supply a successful response or decoded data to application callers, alter a retry's outcome, mutate durable trade state or trigger trading actions. ABI SHALL request transport cancellation without waiting indefinitely for its cooperation. A late response SHALL NOT start body consumption or parsing; a body already being consumed that completes after expiry SHALL NOT be parsed or used. Late failures SHALL be observed without unhandled rejection. Attempt timers and owned listeners SHALL be cleaned up after settlement. Other concurrent requests SHALL retain their own pool and timeout behavior.

#### Scenario: First attempt finishes after the retry succeeds
- **WHEN** the retry succeeds and the expired first fetch later resolves
- **THEN** the caller receives only the retry result
- **AND** the late body is not consumed or parsed, and no extra application or durable action occurs

#### Scenario: Body finishes after timeout
- **WHEN** body consumption ignores abort and finishes after that attempt expires
- **THEN** its contents are not parsed or returned to the caller
- **AND** the expired result does not affect a later operation on the same trade

#### Scenario: Both attempts finish late
- **WHEN** the GET has already failed after two expired attempts and either abandoned attempt later succeeds or rejects
- **THEN** the caller remains failed, no third request starts, no trade state changes, and no unhandled rejection occurs

#### Scenario: Cleanup itself does not finish
- **WHEN** cancellation throws, rejects, or never settles
- **THEN** it cannot keep the expired GET pending or prevent the permitted retry

#### Scenario: A subsequent trade lookup uses fresh evidence
- **WHEN** a required GET fails after two timeouts and its open-position caller returns the existing failure result
- **THEN** that caller's per-trade lock releases through normal completion
- **AND** a later lookup obtains the same key and performs fresh reads
- **AND** deferred results from the older attempts cannot change either lookup's answer or durable state

#### Scenario: POST behavior remains independent
- **WHEN** a trading POST is slow or fails
- **THEN** the GET settlement and retry mechanism does not apply to it
- **AND** its existing write timeout, no-retry behavior and reconciliation semantics remain unchanged
