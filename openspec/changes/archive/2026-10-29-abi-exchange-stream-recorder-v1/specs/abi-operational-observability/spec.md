## ADDED Requirements

### Requirement: Health reports the exchange stream
`GET /health` SHALL include `exchangeStream` with `state` (`disabled`,
`connecting`, `subscribed`, `backoff`, `stopped` during shutdown), the disabled `reason` when disabled,
`connectedSinceMs`, `lastMessageAtMs`, `reconnects`, `bufferedRecords`,
`droppedRecords`, the counters since start `receivedRecords` (records taken
from stream frames), `writtenFacts` and `writtenSnapshots` (rows newly stored),
`duplicateRecords` (records the store already had), `lastWriteAtMs` (last
stored batch of records) and `lastWriteError` when the last flush failed. The stream
state SHALL NOT change `ok` or the HTTP status of `/health`. Recorder events
SHALL contain no secrets and no record payloads.

#### Scenario: Disconnected stream keeps health status
- **WHEN** the recorder is in `backoff` and the entry package path is ready
- **THEN** `/health` answers 200 with `ok: true` and `exchangeStream.state` `backoff`

#### Scenario: Health tells a quiet stream from a failing store
- **WHEN** the stream delivered order and wallet frames and the store wrote them
- **THEN** `receivedRecords`, `writtenFacts` and `writtenSnapshots` grow, `lastWriteAtMs` is set and `lastWriteError` is absent
- **AND** with no frames at all every counter stays 0 and `lastMessageAtMs` and `lastWriteAtMs` are absent
