## Context

ABI configuration is environment-only today (`src/config/config.ts`, `loadConfig(env)`), called once in
`src/app/index.ts`. Engine (`STRATEGY_ENGINE_CONFIG_PATH`) and Runtime (`RUNTIME_CONFIG_PATH`) read an optional file
once at start with `live_entry_mode`. The owner wants the same mechanism in ABI, in JSON because Node has `JSON.parse`
built in.

## Decisions

- **File and path.** `ABI_CONFIG_PATH` (empty or unset = no file). `loadConfig(env)` reads it synchronously with
  `node:fs` `readFileSync` (UTF-8) so the loader stays synchronous and testable with an env object.
- **Missing file = defaults, any other read error = start failure** (owner review 15:46). Unset/blank path, or
  `readFileSync` failing with `ENOENT` → `liveEntryMode = "ema_anchor"`, `touchTriggerEntryOrderType = null`. Any other
  read error (e.g. `EACCES`, `EISDIR`) is rethrown and stops startup; it is never treated as "no configuration". Plain
  `node:fs` error handling, no `existsSync` pre-check.
- **Fail closed** (throw `Error` from `loadConfig`, which stops startup before the server listens) when the file
  exists and:
  - `JSON.parse` fails;
  - the root is not a plain object (`null`, array, or any non-object);
  - a key other than `live_entry_mode`, `touch_trigger_entry_order_type` is present;
  - `live_entry_mode` is present and not the string `ema_anchor` or `touch_trigger`;
  - `touch_trigger_entry_order_type` is present and not the string `market` or `limit`;
  - the mode is `touch_trigger` and `touch_trigger_entry_order_type` is absent (no default type).
- **No consumer.** The two `AbiConfig` fields are read by nothing in this change. No order, Bybit request, contract,
  correlation or recovery behaviour depends on them.
- **No dependencies.** Only Node built-ins.

## Risks

- Engine, Runtime and ABI files can disagree; switch all three together (joint configuration check before enabling).
- Enabling `touch_trigger` before ABI-1 would still place today's conditional-market entry.
