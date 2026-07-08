# attached-entry-protection Specification

## Purpose
TBD - created by archiving change add-attached-protection-v1. Update Purpose after archive.
## Requirements
### Requirement: Signal contract supports optional protection
Abi SHALL accept exactly three bbb signal shapes: entry only, entry with stop loss, and entry with stop loss plus take profit. Abi SHALL reject take profit without stop loss.

#### Scenario: Entry-only signal is accepted
- **WHEN** bbb submits a valid signal with `entry` and without `stop_loss` or `take_profit`
- **THEN** Abi accepts the signal as an entry-only intent

#### Scenario: Entry plus stop signal is accepted
- **WHEN** bbb submits a valid signal with `entry` and `stop_loss` and without `take_profit`
- **THEN** Abi accepts the signal with stop-loss protection

#### Scenario: Entry plus stop plus take signal is accepted
- **WHEN** bbb submits a valid signal with `entry`, `stop_loss`, and `take_profit`
- **THEN** Abi accepts the signal with stop-loss and take-profit protection

#### Scenario: Take profit without stop is rejected
- **WHEN** bbb submits `entry` and `take_profit` without `stop_loss`
- **THEN** Abi rejects the signal before calling Bybit

### Requirement: Execution plan has one protection source of truth
Every execution plan SHALL contain `entryOrder` and `protection`. Protection SHALL be either `{ mode: "none" }` or an `attached_full_position_market` value containing at least one present market protection leg. The execution plan SHALL NOT produce planned-after-fill or compatibility protection fields.

#### Scenario: Entry-only plan has no protection
- **WHEN** Abi builds an execution plan from an entry-only signal
- **THEN** `protection.mode` is `none`
- **AND** the plan does not contain `stopLossAfterFill` or `takeProfitAfterFill`

#### Scenario: Protected plan contains only supplied legs
- **WHEN** Abi builds a plan from a signal with stop loss and optional take profit
- **THEN** `protection.mode` is `attached_full_position_market`
- **AND** its stop-loss and take-profit values exactly reflect the legs supplied by bbb
- **AND** no planned-after-fill fields are produced

### Requirement: Entry-only signal maps without TP/SL fields
Abi SHALL map an entry-only plan to a Bybit create payload containing only entry-order fields and no TP/SL fields.

#### Scenario: Entry-only create payload
- **WHEN** `protection.mode` is `none`
- **THEN** `createEntryOrder` omits `stopLoss`, `takeProfit`, `slTriggerBy`, `tpTriggerBy`, `tpslMode`, `slOrderType`, and `tpOrderType`

### Requirement: Stop-only signal maps only stop loss
Abi SHALL map stop-only protection to a Full-mode market stop loss without adding take-profit fields.

#### Scenario: Entry plus stop create payload
- **WHEN** protection contains `stopLoss` and no `takeProfit`
- **THEN** `createEntryOrder` includes `stopLoss`, `slTriggerBy`, `slOrderType: "Market"`, and `tpslMode: "Full"`
- **AND** it omits `takeProfit`, `tpTriggerBy`, and `tpOrderType`

### Requirement: Stop-plus-take signal maps both protection legs
Abi SHALL map stop-loss and take-profit protection to Full-mode market TP/SL fields using bbb prices unchanged.

#### Scenario: Entry plus stop plus take create payload
- **WHEN** protection contains both `stopLoss` and `takeProfit`
- **THEN** `createEntryOrder` includes both prices, both configured trigger sources, both `Market` order types, and `tpslMode: "Full"`

### Requirement: Pending-intent PUT amends entry and desired protection
`PUT /intents/:signalId` SHALL amend the existing pending entry by its stable entry `orderLinkId`. The amend request SHALL carry the updated entry trigger, stop loss, take profit, and corresponding trigger sources represented by the new desired execution plan, and SHALL explicitly clear protection legs removed by the PUT representation.

#### Scenario: PUT updates entry stop and take together
- **WHEN** bbb submits a valid PUT body with new entry, stop-loss, and take-profit prices
- **THEN** the amend payload targets the existing entry `orderLinkId`
- **AND** contains the updated `triggerPrice`, `stopLoss`, `takeProfit`, `slTriggerBy`, and `tpTriggerBy`

#### Scenario: PUT removes take profit
- **WHEN** the existing pending intent has stop loss and take profit and the new valid PUT body contains stop loss only
- **THEN** the amend payload updates stop loss and explicitly clears take profit

#### Scenario: PUT removes all protection
- **WHEN** the new valid PUT body is entry only
- **THEN** the amend payload updates entry and explicitly clears stop loss and take profit

### Requirement: API responses expose only the current protection model
Create and update responses SHALL expose the execution plan's single `protection` model and exact Bybit payload preview. They SHALL NOT expose planned-after-fill or compatibility fields.

#### Scenario: Dry-run response reflects entry-only plan
- **WHEN** an entry-only signal is accepted in dry-run mode
- **THEN** the response shows `protection.mode` as `none`
- **AND** the Bybit preview has no TP/SL fields
- **AND** no planned-after-fill response fields are present

#### Scenario: Dry-run response reflects supplied protection
- **WHEN** a protected signal is accepted in dry-run mode
- **THEN** the response shows only the supplied protection legs and their mapped Bybit fields

### Requirement: Existing execution safeguards remain in force
Optional attached protection SHALL NOT change fixed sizing, deterministic entry identity, dry-run behavior, credential checks, demo/testnet gates, or the mainnet guard. This change SHALL NOT implement verification, watcher, repair, emergency close, partial TP, limit TP/SL, or sizing changes.

#### Scenario: Mainnet remains blocked
- **WHEN** execution is configured with `BYBIT_ENV=mainnet`
- **THEN** the live guard prevents create and amend requests from reaching Bybit

#### Scenario: Verification and repair are absent
- **WHEN** a protected create or amend is acknowledged
- **THEN** this change performs no post-acknowledgement polling, protection verification, watcher action, repair, or emergency close

