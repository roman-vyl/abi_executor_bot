## Why

Abi currently records stop-loss and take-profit prices in its execution plan but sends only the conditional entry order to Bybit. Attaching full-position market protection to the entry create request reduces the window in which a filled position could exist without its intended protection and establishes a safer base for later verification and repair workflows.

## What Changes

- Extend the execution plan with an explicit full-position market attached-protection model while retaining the existing planned-after-fill fields for response compatibility.
- Include bbb-provided stop-loss and take-profit prices, trigger sources, `tpslMode=Full`, and market TP/SL order types in Bybit entry create payloads.
- Include updated entry, stop-loss, and take-profit values in pending-entry amend payloads.
- Expose attached protection explicitly in dry-run, live create, and update responses without removing existing response fields.
- Add future-facing protection state and repair action types without connecting them to runtime behavior.
- Add guarded demo/testnet smoke coverage and document the attached-protection contract and operational boundaries.
- Make sandbox queries tolerant of Bybit's asynchronous create/amend acknowledgement by using a short bounded retry, without treating absent TP/SL fields in realtime query output as a v1 failure.
- Preserve fixed sizing, existing create/query/amend/cancel behavior, dry-run behavior, journal flows, and the mainnet live guard.
- Explicit non-goals: no fill watcher, post-create protection verification, trading-stop repair, emergency close, partial TP, limit TP/SL, sizing changes, or mainnet enablement.

## Capabilities

### New Capabilities

- `attached-entry-protection`: Define how Abi plans, maps, reports, amends, documents, and smoke-tests full-position market stop-loss and take-profit protection attached to a Bybit conditional entry.

### Modified Capabilities

None. No existing OpenSpec capabilities are present.

## Impact

- Domain and mapping: `src/domain/executionPlan.ts`, `src/exchange/bybitOrderMapper.ts`.
- API responses and update flow: `src/routes/signalRoutes.ts`, `src/services/intents/updateIntent.ts`.
- Future architecture only: new types under `src/services/protection/` with no runtime wiring.
- Verification: mapper, route/service, and risk-regression unit tests; `npm test`; `npm run build`; a new guarded sandbox smoke script that is added but not run as part of this change.
- Documentation and operator guidance: README, bbb contract, roadmap, sandbox smoke guide, and a dedicated attached-protection v1 document, including the v1 default `LastPrice` trigger source and the option to split entry/TP/SL trigger sources later.
- External behavior: Bybit demo/testnet create and amend requests gain attached TP/SL fields. Mainnet remains blocked. No new dependency or secret is introduced.
- Safety and recovery boundary: v1 relies on Bybit accepting attached protection atomically with the entry; verification, journaled protection state transitions, and repair remain future work and must not be implied as completed.
