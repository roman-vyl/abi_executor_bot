## ADDED Requirements

### Requirement: Abi verifies live create result after successful entry placement
Abi SHALL run a bounded post-create protection verification step after a successful live entry create acknowledgement. Abi SHALL NOT run this exchange verification for dry-run responses or failed create attempts.

#### Scenario: Live create accepted starts verification
- **WHEN** `POST /signals` successfully creates a live entry order
- **THEN** Abi retries a query for the pending entry order by the entry `orderLinkId`
- **AND** Abi queries the current position for the signal symbol

#### Scenario: Dry-run create does not query exchange
- **WHEN** `POST /signals` is handled in dry-run mode
- **THEN** Abi does not query Bybit for order, position, or market price during protection verification
- **AND** Abi does not send an emergency close

#### Scenario: Failed create does not run verification
- **WHEN** the live entry create request fails or is blocked before successful placement
- **THEN** Abi does not run post-create protection verification

### Requirement: Abi distinguishes pending order from open position
Abi SHALL evaluate the post-create state using both pending order lookup and position lookup. A pending order with no open position SHALL be treated differently from an already-open position.

#### Scenario: Pending order found and no position
- **WHEN** the pending entry order is found by `orderLinkId`
- **AND** no position is open for the symbol
- **THEN** Abi reports `pending_order_verified`
- **AND** Abi performs no emergency close

#### Scenario: Pending order not found and no position
- **WHEN** the pending entry order is not found after bounded retry
- **AND** no position is open for the symbol
- **THEN** Abi reports `pending_order_not_found` or an equivalent manual-investigation status
- **AND** Abi performs no emergency close

#### Scenario: Position found enters position branch
- **WHEN** a position is open for the symbol
- **THEN** Abi evaluates the position branch regardless of whether the pending order query found the entry order

### Requirement: Abi emergency-closes only breached protected positions
Abi SHALL send a market reduce-only emergency close only when a position is already open, the intent requested a stop loss, and the observed market price has breached that requested stop. Abi SHALL NOT close blindly when required state cannot be confirmed.

#### Scenario: Long position breaches requested stop
- **WHEN** a long position is open
- **AND** the intent requested a stop loss
- **AND** the observed market price is less than or equal to the stop-loss trigger price
- **THEN** Abi sends a guarded market reduce-only close for the open position
- **AND** Abi reports `emergency_close_sent` or an equivalent emergency-close status

#### Scenario: Short position breaches requested stop
- **WHEN** a short position is open
- **AND** the intent requested a stop loss
- **AND** the observed market price is greater than or equal to the stop-loss trigger price
- **THEN** Abi sends a guarded market reduce-only close for the open position
- **AND** Abi reports `emergency_close_sent` or an equivalent emergency-close status

#### Scenario: Position open but no stop requested
- **WHEN** a position is open
- **AND** the intent did not request a stop loss
- **THEN** Abi reports `position_open_no_stop_requested` or an equivalent status
- **AND** Abi performs no emergency close

#### Scenario: Protected position not breached
- **WHEN** a position is open
- **AND** the intent requested a stop loss
- **AND** Abi observes that the current price has not breached the stop-loss trigger price
- **THEN** Abi performs no emergency close
- **AND** Abi reports `position_open_stop_safe`, `unsafe_manual_required`, or an equivalent status based on whether protection can be confirmed

#### Scenario: Price query failed
- **WHEN** a position is open
- **AND** the intent requested a stop loss
- **AND** Abi cannot obtain the current market price
- **THEN** Abi reports `exchange_query_failed` or `unsafe_manual_required`
- **AND** Abi performs no emergency close

### Requirement: Abi reports protection check result
Abi SHALL include a structured post-create protection check result in successful live `POST /signals` responses and SHALL append protection-check journal events without leaking secrets.

#### Scenario: Live response includes protection check
- **WHEN** `POST /signals` successfully creates a live entry order
- **THEN** the response includes `protectionCheck`
- **AND** the result includes status, action, signal id, instance id, symbol, side, entry `orderLinkId`, requested protection, order-found state, position-found state, reason, and retry metadata when available

#### Scenario: Emergency close result includes close metadata
- **WHEN** Abi sends an emergency close during post-create verification
- **THEN** `protectionCheck` includes emergency close order metadata that is safe to expose to operators

#### Scenario: Journal records check result
- **WHEN** Abi runs post-create protection verification
- **THEN** Abi appends journal events for protection check start and completion or failure
- **AND** Abi appends an emergency-close event when a close is sent

### Requirement: Guards remain enforced
Post-create verification SHALL preserve dry-run behavior, demo/testnet safety gates, and the mainnet live guard. Abi SHALL NOT attempt trading-stop repair in this change.

#### Scenario: Mainnet guard blocks emergency close
- **WHEN** the existing live execution guard blocks live writes
- **AND** post-create verification reaches a decision that would otherwise close a position
- **THEN** Abi does not bypass the guard
- **AND** no unguarded emergency close reaches Bybit

#### Scenario: No automatic trading-stop repair is attempted
- **WHEN** a position is open and requested protection cannot be confirmed
- **THEN** Abi does not call `/v5/position/trading-stop`
- **AND** Abi reports `unsafe_manual_required` or an equivalent manual status unless an emergency close is required by stop breach

#### Scenario: Verification is post-create only
- **WHEN** `PUT /intents/:signalId` amends a pending intent
- **THEN** this v1 change does not require post-amend protection verification

#### Scenario: Existing cancel and operator endpoints are unchanged
- **WHEN** cancel flow or existing operator emergency endpoints run
- **THEN** their existing behavior is preserved
