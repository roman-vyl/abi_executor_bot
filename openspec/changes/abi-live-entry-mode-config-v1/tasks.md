## 1. Config

- [ ] 1.1 `AbiConfig.liveEntryMode` (`"ema_anchor" | "touch_trigger"`) and `touchTriggerEntryOrderType` (`"market" | "limit" | null`)
- [ ] 1.2 `loadConfig` reads `ABI_CONFIG_PATH` once with `node:fs` + `JSON.parse`; missing path/file = defaults; all fail-closed cases throw
- [ ] 1.3 `config/abi.example.json`, README and RUNBOOK: file, keys, values, restart to switch, not to be enabled before ABI-1

## 2. Tests (targeted only)

- [ ] 2.1 Config tests: no path, missing file, empty object, each mode, touch_trigger with market/limit, touch_trigger without type, invalid JSON, `[]`, `null`, unknown key, bad mode, bad type, ema_anchor with a valid/invalid type
- [ ] 2.2 Existing config tests green; typecheck clean
