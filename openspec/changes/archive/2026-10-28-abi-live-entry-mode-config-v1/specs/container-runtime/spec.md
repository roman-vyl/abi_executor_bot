## ADDED Requirements

### Requirement: ABI live-entry configuration file
ABI SHALL read an optional JSON file named by `ABI_CONFIG_PATH` once at
start, using only Node built-ins. Allowed keys are `live_entry_mode`
(`ema_anchor` default, or `touch_trigger`) and
`touch_trigger_entry_order_type` (`market` or `limit`, no default). An unset
path or a missing file SHALL mean `ema_anchor` with no order type. Startup
SHALL fail when the file is not valid JSON, its root is not a plain object,
it has an unknown key, a value is not allowed, or `live_entry_mode` is
`touch_trigger` without `touch_trigger_entry_order_type`. In `ema_anchor` the
order type SHALL be optional and validated when present. The resolved values
SHALL be part of the ABI configuration and no order placement, Bybit request,
Runtime contract or recovery behaviour SHALL depend on them.

#### Scenario: No config file
- **WHEN** `ABI_CONFIG_PATH` is unset or names a missing file
- **THEN** the configuration carries `live_entry_mode = ema_anchor` and no
  entry order type

#### Scenario: touch_trigger with an order type
- **WHEN** the file is `{"live_entry_mode": "touch_trigger", "touch_trigger_entry_order_type": "market"}`
- **THEN** the configuration carries `touch_trigger` and `market`

#### Scenario: touch_trigger without an order type
- **WHEN** the file is `{"live_entry_mode": "touch_trigger"}`
- **THEN** ABI startup fails with an error

#### Scenario: Invalid file shapes
- **WHEN** the file is `[]`, `null`, not valid JSON, has an unknown key, or
  has a value outside the allowed strings
- **THEN** ABI startup fails with an error

#### Scenario: Orders unchanged
- **WHEN** the same entry package is applied with no file and with
  `touch_trigger` + `market`
- **THEN** ABI sends the same Bybit requests
