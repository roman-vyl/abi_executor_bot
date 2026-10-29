## ADDED Requirements

### Requirement: Health reports the exchange order linker
`GET /health` SHALL include `exchangeLinker` with `state` (`disabled`,
`waiting_for_correlation`, `running`, `stopped`), the disabled `reason` when
disabled, `lastTickAtMs`, `linksWritten`, `waitingOrders`
(count per reason), `notLinkableOrders` (count per reason) and `lastError` when the last tick
failed. The linker state SHALL NOT change `ok` or the HTTP status of
`/health`. Linker events SHALL contain no secrets and no record payloads.

#### Scenario: Linker error keeps health status
- **WHEN** the last linker tick failed and the entry package path is ready
- **THEN** `/health` answers 200 with `ok: true` and `exchangeLinker.lastError` set
