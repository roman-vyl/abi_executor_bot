## Why

Owner plan 2026-10-28 15:38 and review 15:40 (thread «Перевести вход на цену закрытия свечи касания»): ABI must read
its own live-entry configuration the same way Strategy Engine and Strategy Runtime do. Engine and Runtime decide when an
entry exists, when it expires and whether it is cancelled or replaced; ABI only decides which exchange order executes an
`APPLY`. This is step ABI-0: configuration only.

Later steps (each its own change, on the owner's word): ABI-1 market entry in `touch_trigger`, ABI-2 limit entry in
`touch_trigger` (price to be agreed), ABI-3 integration checks.

## What Changes

- New env var `ABI_CONFIG_PATH` naming an optional JSON file (stack: `BBB_data/abi/config/abi.json`, mounted read-only
  at `/app/config`; the mount is a separate bbb_stack change).
- `loadConfig()` reads the file once at start with `node:fs` and `JSON.parse()`. No new dependency, no own parser, no
  schema library.
- Keys:

  | key | values | default |
  |---|---|---|
  | `live_entry_mode` | `ema_anchor`, `touch_trigger` | `ema_anchor` |
  | `touch_trigger_entry_order_type` | `market`, `limit` | none |

- Unset path or missing file → `ema_anchor`, no order type. Start fails when the file exists but: is not valid JSON;
  its root is not a plain object (array, `null`, string, number); it has an unknown key; a value is not one of the
  allowed strings; or `live_entry_mode` is `touch_trigger` and `touch_trigger_entry_order_type` is absent. In
  `ema_anchor` the order type is optional, validated when present, and unused.
- `AbiConfig` gains `liveEntryMode` and `touchTriggerEntryOrderType` (`"market" | "limit" | null`). Nothing reads them:
  order placement, Bybit requests, the Runtime ↔ ABI contract and recovery are unchanged in both modes.
- Switching = edit the file + restart ABI.
- `config/abi.example.json`, README and RUNBOOK document the file.

## Safety

With `{"live_entry_mode": "touch_trigger", "touch_trigger_entry_order_type": "market"}` ABI still places exactly the
same orders as today. `touch_trigger` must not be enabled on a trading stack before ABI-1.

## Out of scope

Any order-placement change (ABI-1, ABI-2), integration checks (ABI-3), bbb_stack mount and deployment.

## Impact

- `src/config/config.ts` (`AbiConfig`, `loadConfig`), `test/unit/config.test.ts`, `config/abi.example.json`, README,
  `docs/RUNBOOK.md`.
- Spec `container-runtime`: one added requirement.
