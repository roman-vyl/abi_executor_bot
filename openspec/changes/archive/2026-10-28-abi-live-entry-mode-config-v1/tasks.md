## 1. Config

- [x] 1.1 `AbiConfig.liveEntryMode` (`"ema_anchor" | "touch_trigger"`) and `touchTriggerEntryOrderType` (`"market" | "limit" | null`)
- [x] 1.2 `loadConfig` reads `ABI_CONFIG_PATH` once with `node:fs` + `JSON.parse`; missing path/file = defaults; all fail-closed cases throw
- [x] 1.3 `config/abi.example.json`, README and RUNBOOK: file, keys, values, restart to switch, not to be enabled before ABI-1

## 2. Tests (targeted only)

- [x] 2.1 Config tests: no path, missing file, empty object, each mode, touch_trigger with market/limit, touch_trigger without type, invalid JSON, `[]`, `null`, unknown key, bad mode, bad type, ema_anchor with a valid/invalid type
- [x] 2.2 Existing config tests green; typecheck clean
