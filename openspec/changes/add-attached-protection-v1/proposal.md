## Why

Abi currently models stop-loss and take-profit as hypothetical orders to place after fill, even though Bybit can attach full-position market protection directly to the conditional entry. Because Abi is new and has no compatibility burden, the execution plan should model only the desired entry and its optional attached protection.

## What Changes

- Allow bbb to submit three signal shapes: entry only, entry plus stop loss, or entry plus stop loss and take profit.
- Replace the temporary planned-after-fill fields with one authoritative `ExecutionPlan.protection` union: `none` or `attached_full_position_market` with optional stop-loss and take-profit legs.
- Map only present protection legs into the Bybit create payload; entry-only requests contain no TP/SL fields.
- Amend a pending entry's trigger price and desired attached stop-loss/take-profit through the existing `PUT /intents/:signalId` flow and stable entry `orderLinkId`.
- Expose the single protection model in dry-run and live previews without compatibility or planned-after-fill fields.
- Update focused tests and documentation for optional protection and market-only Full mode.
- Preserve fixed sizing, existing guards, journaling, and current create/query/amend/cancel behavior.
- Explicit non-goals: no post-create verification, query retry, fill watcher, trading-stop repair, emergency close, partial TP, limit TP/SL, sizing changes, or mainnet enablement.

## Capabilities

### New Capabilities

- `attached-entry-protection`: Define optional full-position market protection attached to a Bybit conditional entry, including entry-only, stop-only, and stop-plus-take-profit signals and pending-intent amendment.

### Modified Capabilities

None. No existing OpenSpec capabilities are present.

## Impact

- Signal contract and validation: `src/domain/signals.ts`, `src/risk/riskGuard.ts`, bbb contract documentation, and fixtures.
- Domain and mapping: `src/domain/executionPlan.ts`, `src/exchange/bybitOrderMapper.ts`.
- API responses and update flow: `src/routes/signalRoutes.ts`, `src/services/intents/updateIntent.ts`.
- Tests: optional signal parsing/risk checks, execution-plan shape, conditional create mapping, amend mapping, and response previews.
- External behavior: Bybit demo/testnet create and amend payloads include only the protection fields represented by the signal. Mainnet remains blocked and no dependency or secret is introduced.
- Follow-up: `protection-verification-and-repair-v1` will own asynchronous query/retry, pending-order protection verification, after-fill watching, repair, and emergency close decisions.
