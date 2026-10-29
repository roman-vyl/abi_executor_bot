## ADDED Requirements

### Requirement: Health reports REST reconciliation and completeness
`GET /health` SHALL include `exchangeRest` with `state` (`disabled`,
`backfilling`, `idle`, `fetching`, `stopped`), the disabled `reason`,
`coveredFromMs`, `backfillDone`, `queueWindows`, `requests`,
`recordsFetched`, `recordsNew`, `lastSweepAtMs` and `lastError`, and
`exchangeCompleteness` with `checkedAtMs`, `execMismatchOrders`,
`uncoveredGaps`, `closedCyclesWithoutCloseFill` and `unlabeledRestOrders`.
They SHALL NOT change `ok` or the HTTP status. Events SHALL contain no
secrets and no record payloads.

#### Scenario: Backfill running
- **WHEN** the startup backfill is in progress and the entry package path is ready
- **THEN** `/health` answers 200 with `ok: true` and `exchangeRest.state` `backfilling`
