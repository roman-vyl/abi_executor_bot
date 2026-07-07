## ADDED Requirements

### Requirement: Execution plan models attached protection explicitly
Abi SHALL represent full-position market stop-loss and take-profit protection as an explicit `attachedProtection` component of every execution plan built from a valid bbb signal. The component SHALL carry the bbb-provided absolute trigger prices, the configured Bybit trigger source, `full_position_market` mode, and market order types. Abi SHALL retain the existing `stopLossAfterFill` and `takeProfitAfterFill` plan fields during v1 for backward compatibility.

#### Scenario: Long plan contains attached protection
- **WHEN** Abi builds an execution plan for a valid long signal
- **THEN** `attachedProtection.stopLoss.triggerPrice` equals `intent.stopLoss.triggerPrice`
- **AND** `attachedProtection.takeProfit.triggerPrice` equals `intent.takeProfit.triggerPrice`
- **AND** both attached orders use the configured trigger source and `Market` order type
- **AND** the legacy planned-after-fill fields remain present

#### Scenario: Short plan preserves bbb prices
- **WHEN** Abi builds an execution plan for a valid short signal where take profit is below entry and stop loss is above entry
- **THEN** the attached protection preserves those stop-loss and take-profit prices without swapping or deriving them

### Requirement: Create payload attaches full-position market TP and SL
Abi SHALL map attached protection into the Bybit V5 entry create payload using `takeProfit`, `stopLoss`, `tpTriggerBy`, `slTriggerBy`, `tpslMode: "Full"`, `tpOrderType: "Market"`, and `slOrderType: "Market"`. Existing entry, quantity, trigger, side, and `orderLinkId` mapping SHALL remain unchanged.

#### Scenario: Long entry maps to protected Buy order
- **WHEN** Abi maps a long stop-market execution plan with `rises_to`
- **THEN** the create payload uses side `Buy` and trigger direction `1`
- **AND** it includes the plan's take-profit and stop-loss prices
- **AND** it uses full-position market TP/SL with the configured trigger source

#### Scenario: Short entry maps to protected Sell order
- **WHEN** Abi maps a short stop-market execution plan with valid short TP/SL prices
- **THEN** the create payload uses side `Sell`
- **AND** it passes the lower take-profit and higher stop-loss prices through unchanged
- **AND** it uses full-position market TP/SL

### Requirement: Pending-entry amend updates attached protection
Abi SHALL include the updated entry trigger price, take-profit price, stop-loss price, and TP/SL trigger sources in the Bybit V5 amend payload produced for `PUT /intents/:signalId`. The amend flow SHALL retain existing validation, identity, journaling, dry-run, and live-guard behavior.

#### Scenario: Update maps all three changed prices
- **WHEN** bbb updates a pending intent with a new entry trigger, stop loss, and take profit
- **THEN** the amend payload contains the new `triggerPrice`, `stopLoss`, and `takeProfit`
- **AND** it includes `tpTriggerBy` and `slTriggerBy` from configuration
- **AND** it targets the existing entry `orderLinkId`

#### Scenario: Invalid updated price ordering is rejected
- **WHEN** an update violates the existing long or short price-ordering rule
- **THEN** Abi rejects the update before calling Bybit

### Requirement: API responses expose attached protection compatibly
Create and update responses SHALL expose the attached-protection plan in a new `wouldAttachProtection` field for dry-run, live success, and Bybit create/amend failure responses. Abi SHALL preserve the existing entry and planned-after-fill response fields during v1.

#### Scenario: Dry-run create reports attached protection
- **WHEN** a valid signal is accepted while live execution is disabled
- **THEN** the response status remains `accepted_dry_run`
- **AND** `wouldAttachProtection` contains the stop-loss, take-profit, mode, trigger sources, and market order types
- **AND** `wouldSendToBybit.createEntryOrder` shows the attached TP/SL fields
- **AND** existing `wouldCreateEntry`, `wouldCreateStopLossAfterFill`, and `wouldCreateTakeProfitAfterFill` fields remain present

#### Scenario: Dry-run update reports amended protection
- **WHEN** a valid pending intent update is processed in dry-run mode
- **THEN** the response status remains `updated_dry_run`
- **AND** `wouldAttachProtection` and `wouldSendToBybit.amendEntryOrder` show the updated stop-loss and take-profit values
- **AND** existing update response fields remain present

#### Scenario: Bybit failure remains observable
- **WHEN** Bybit rejects a protected create or amend request
- **THEN** Abi preserves the existing failure status and journal behavior
- **AND** the failure response shows the attached protection that Abi attempted to send

### Requirement: Existing execution safeguards remain in force
Attached protection SHALL use the existing fixed position quantity and SHALL NOT weaken dry-run, credential, demo/testnet, or mainnet guard behavior. v1 SHALL NOT add fill watching, protection verification or repair, emergency close, partial TP, limit TP/SL, or mainnet execution.

#### Scenario: Mainnet remains blocked
- **WHEN** attached-protection execution is configured with `BYBIT_ENV=mainnet`
- **THEN** the live guard prevents the create or amend request from reaching Bybit

#### Scenario: Quantity remains fixed
- **WHEN** Abi builds a protected entry plan in v1
- **THEN** entry sizing continues to use `ABI_FIXED_SMOKE_QTY`

### Requirement: Future protection states are typed but not executed
Abi SHALL define non-runtime protection state, repair action, and check result types under `src/services/protection/` for future verification and recovery work. No v1 route, service, watcher, or journal flow SHALL execute a repair action.

#### Scenario: Future model represents unsafe states and repairs
- **WHEN** TypeScript consumers import the future protection model
- **THEN** it can represent `not_checked`, `attached_to_entry`, `active_on_position`, `missing`, `invalid`, and `breached` states
- **AND** it can represent `none`, `set_trading_stop`, and `close_position_market` repair actions

### Requirement: Guarded sandbox smoke covers attached protection
The project SHALL provide a `smoke:sandbox:attached-protection` command that refuses to run without explicit write confirmation, validates the execution mode, creates and queries a protected entry, prints available protection values, cancels the intent, and reports final active-order state. Adding this script SHALL NOT authorize or automatically run a live smoke.

#### Scenario: Confirmation is absent
- **WHEN** the smoke command runs without `ABI_CONFIRM_TESTNET_WRITE=YES`
- **THEN** it exits before creating an order

#### Scenario: Sandbox mode is valid
- **WHEN** the smoke command runs with explicit confirmation and `/execution/mode` reports demo or testnet with `canExecuteLive: true`
- **THEN** it performs create, query, cancel, and final active-order query in that order
- **AND** it prints create, query, cancel, and cleanup statuses plus any available `takeProfit`, `stopLoss`, and `tpslMode`

