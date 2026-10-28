## ADDED Requirements

### Requirement: Entry order type follows the live-entry configuration
ABI SHALL build the entry create request from the live-entry configuration
loaded at start. In `ema_anchor` the request SHALL be the existing conditional
`Market` order with `triggerPrice`, `triggerDirection` and `triggerBy`. In
`touch_trigger` with `touch_trigger_entry_order_type = market` the request
SHALL be a plain `Market` order that contains none of `triggerPrice`,
`triggerDirection` or `triggerBy`, and all its other fields (category, symbol,
side, quantity, `orderLinkId`, position index, `tpslMode: Partial`, stop loss
and take profit with their trigger source and `Market` order types) SHALL be
identical to the `ema_anchor` request for the same package. Correlation,
confirmation, cancellation, recovery and the Runtime contract SHALL be the same
in both modes.

#### Scenario: ema_anchor request unchanged
- **WHEN** an entry package is applied with `live_entry_mode = ema_anchor`
- **THEN** ABI sends the same conditional `Market` create request as before
  this change

#### Scenario: touch_trigger market request
- **WHEN** an entry package is applied with `touch_trigger` + `market`
- **THEN** ABI sends a `Market` create request without `triggerPrice`,
  `triggerDirection` and `triggerBy`, with Partial `Market` stop loss and take
  profit and the same `orderLinkId`

#### Scenario: Immediate or partial fill
- **WHEN** the plain `Market` entry fills fully, or partly with the remainder
  cancelled, before confirmation
- **THEN** ABI confirms and acknowledges it through the existing fill
  classification, without a new recovery path

#### Scenario: Unsupported mode reaches the mapper
- **WHEN** the mapper receives `touch_trigger` without order type `market`
- **THEN** it throws and no create request is sent
