# post-create-protection-verification Specification

## Purpose
TBD - created by archiving change post-create-protection-verification-v1. Update Purpose after archive.

## Requirements
### Requirement: Abi captures a pre-create position snapshot
Abi SHALL query a pre-create position snapshot for the signal symbol before sending a live create when post-create verification is enabled. Abi SHALL use this snapshot as the attribution boundary for any emergency close decision.

#### Scenario: Pre-create position exists
- **WHEN** the pre-create position snapshot finds a non-zero/open position
- **THEN** Abi reports `pre_existing_position_found`
- **AND** `action` is `none`
- **AND** Abi does not block the normal guarded live create solely because of this snapshot
- **AND** Abi does not send an emergency close
- **AND** the reason explains that the position cannot be safely attributed to the just-created entry

#### Scenario: Pre-create position query failed
- **WHEN** Abi cannot obtain the pre-create position snapshot
- **THEN** Abi reports `exchange_query_failed`
- **AND** `action` is `none`
- **AND** Abi does not send the live create request
- **AND** Abi does not send an emergency close

#### Scenario: Pre-create zero allows post-create attribution
- **WHEN** the pre-create position snapshot is zero/absent
- **AND** a post-create position becomes non-zero/open
- **THEN** Abi may treat the position as newly opened by the just-created entry for v1 stop-breach evaluation

### Requirement: Abi verifies live create result after successful entry placement
Abi SHALL run a bounded post-create protection verification step after a successful live entry create acknowledgement. Abi SHALL NOT run exchange verification for dry-run responses or failed create attempts.

#### Scenario: Live create accepted starts post-create verification
- **WHEN** `POST /signals` successfully creates a live entry order after a zero/absent pre-create position snapshot
- **THEN** Abi retries a query for the pending entry order by the entry `orderLinkId`
- **AND** Abi queries the post-create position for the signal symbol

#### Scenario: Dry-run create does not query exchange
- **WHEN** `POST /signals` is handled in dry-run mode
- **THEN** Abi reports `not_run_dry_run`
- **AND** Abi does not query Bybit for order, position, or market price during protection verification
- **AND** Abi does not send an emergency close

#### Scenario: Failed create does not run post-create verification
- **WHEN** the live entry create request fails or is blocked before successful placement
- **THEN** Abi does not run post-create order or position verification
- **AND** Abi does not send an emergency close

### Requirement: Abi distinguishes pending order from open position
Abi SHALL evaluate the post-create state using both pending order lookup and post-create position lookup. A pending order with no open position SHALL be treated differently from a newly opened position.

#### Scenario: Pending order found and no position
- **WHEN** the pre-create position snapshot is zero/absent
- **AND** the pending entry order is found by `orderLinkId`
- **AND** no post-create position is open for the symbol
- **THEN** Abi reports `pending_order_verified`
- **AND** `action` is `none`
- **AND** Abi performs no emergency close

#### Scenario: Pending order not found and no position
- **WHEN** the pre-create position snapshot is zero/absent
- **AND** the pending entry order is not found after bounded retry
- **AND** no post-create position is open for the symbol
- **THEN** Abi reports `pending_order_not_found`
- **AND** `action` is `none`
- **AND** Abi performs no emergency close

#### Scenario: Post-create position found enters position branch
- **WHEN** the pre-create position snapshot is zero/absent
- **AND** a post-create position is open for the symbol
- **THEN** Abi evaluates the newly-opened-position branch regardless of whether the pending order query found the entry order

### Requirement: Abi emergency-closes only breached newly opened protected positions
Abi SHALL send a market reduce-only emergency close only when the pre-create position was zero/absent, the post-create position is open, the intent requested a stop loss, and the observed market price has breached that requested stop. Abi SHALL NOT close blindly when required state cannot be confirmed.

#### Scenario: Long newly opened position breaches requested stop
- **WHEN** the pre-create position snapshot is zero/absent
- **AND** a long post-create position is open
- **AND** the intent requested a stop loss
- **AND** the observed market price is less than or equal to the stop-loss trigger price
- **THEN** Abi reports `position_open_stop_breached`
- **AND** Abi attempts one guarded market reduce-only close for the open position

#### Scenario: Short newly opened position breaches requested stop
- **WHEN** the pre-create position snapshot is zero/absent
- **AND** a short post-create position is open
- **AND** the intent requested a stop loss
- **AND** the observed market price is greater than or equal to the stop-loss trigger price
- **THEN** Abi reports `position_open_stop_breached`
- **AND** Abi attempts one guarded market reduce-only close for the open position

#### Scenario: Emergency close sent
- **WHEN** Abi attempts the guarded market reduce-only close
- **AND** the guarded execution layer accepts/sends the close request
- **THEN** Abi reports `emergency_close_sent`
- **AND** `protectionCheck` includes operator-safe emergency close order metadata

#### Scenario: Emergency close failed
- **WHEN** Abi attempts the guarded market reduce-only close
- **AND** the live guard, adapter, or Bybit close request fails
- **THEN** Abi reports `emergency_close_failed`
- **AND** `protectionCheck` includes operator-safe error metadata
- **AND** Abi appends an `emergency_close_failed` journal event or a `protection_check_failed` journal event with the close failure reason
- **AND** Abi does not retry forever
- **AND** Abi does not send blind repeated close requests

#### Scenario: Position open but no stop requested
- **WHEN** the pre-create position snapshot is zero/absent
- **AND** a post-create position is open
- **AND** the intent did not request a stop loss
- **THEN** Abi reports `position_open_no_stop_requested`
- **AND** `action` is `none`
- **AND** Abi performs no emergency close

#### Scenario: Position open and stop not breached
- **WHEN** the pre-create position snapshot is zero/absent
- **AND** a post-create position is open
- **AND** the intent requested a stop loss
- **AND** Abi observes that the current price has not breached the stop-loss trigger price
- **THEN** Abi reports `position_open_stop_not_breached`
- **AND** `action` is `none`
- **AND** Abi performs no emergency close
- **AND** Abi does not call `/v5/position/trading-stop`

#### Scenario: Price query failed
- **WHEN** the pre-create position snapshot is zero/absent
- **AND** a post-create position is open
- **AND** the intent requested a stop loss
- **AND** Abi cannot obtain the current market price
- **THEN** Abi reports `exchange_query_failed`
- **AND** `action` is `none`
- **AND** Abi performs no emergency close

### Requirement: Abi reports protection check result
Abi SHALL include a structured protection check result in `POST /signals` responses when verification runs or is intentionally not run for dry-run. Abi SHALL append protection-check journal events without leaking secrets.

#### Scenario: Response includes protection check
- **WHEN** `POST /signals` returns from a create flow that reached protection verification or dry-run protection preview
- **THEN** the response includes `protectionCheck`
- **AND** the result includes status, action, signal id, instance id, symbol, side, entry `orderLinkId`, requested protection, pre-create position state, order-found state, post-create position state, reason, and retry metadata when available

#### Scenario: Journal records check result
- **WHEN** Abi runs pre-create or post-create protection verification
- **THEN** Abi appends journal events for protection check start and completion or failure
- **AND** Abi appends `emergency_close_sent` when a close is sent
- **AND** Abi appends `emergency_close_failed` when a close fails

### Requirement: Guards and v1 boundaries remain enforced
Post-create verification SHALL preserve dry-run behavior, demo/testnet safety gates, and the mainnet live guard. Abi SHALL NOT attempt trading-stop repair, watcher behavior, or post-amend verification in this change.

#### Scenario: Mainnet guard blocks emergency close
- **WHEN** the existing live execution guard blocks live writes
- **AND** post-create verification reaches a decision that would otherwise close a position
- **THEN** Abi does not bypass the guard
- **AND** no unguarded emergency close reaches Bybit
- **AND** Abi reports `emergency_close_failed`

#### Scenario: No automatic trading-stop repair is attempted
- **WHEN** a position is open and requested protection cannot be confirmed
- **THEN** Abi does not call `/v5/position/trading-stop`
- **AND** Abi does not claim that exchange-side active protection is proven

#### Scenario: V1 only checks requested stop breach
- **WHEN** Abi reports `position_open_stop_not_breached`
- **THEN** the status means only that observed price has not crossed the requested stop
- **AND** the status does not prove active exchange-side TP/SL protection

#### Scenario: Verification is post-create only
- **WHEN** `PUT /intents/:signalId` amends a pending intent
- **THEN** this v1 change does not require post-amend protection verification

#### Scenario: Existing cancel and operator endpoints are unchanged
- **WHEN** cancel flow or existing operator emergency endpoints run
- **THEN** their existing behavior is preserved
