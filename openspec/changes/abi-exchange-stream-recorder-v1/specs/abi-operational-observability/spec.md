## ADDED Requirements

### Requirement: Health reports the exchange stream
`GET /health` SHALL include `exchangeStream` with `state` (`disabled`,
`connecting`, `subscribed`, `backoff`), the disabled `reason` when disabled,
`connectedSinceMs`, `lastMessageAtMs`, `reconnects`, `bufferedRecords`,
`droppedRecords` and `lastWriteError` when the last flush failed. The stream
state SHALL NOT change `ok` or the HTTP status of `/health`. Recorder events
SHALL contain no secrets and no record payloads.

#### Scenario: Disconnected stream keeps health status
- **WHEN** the recorder is in `backoff` and the entry package path is ready
- **THEN** `/health` answers 200 with `ok: true` and `exchangeStream.state` `backoff`
