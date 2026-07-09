## Why

Abi already handles the placement layer for bbb signals: it can create, query, amend, and cancel Bybit demo/testnet entry orders with optional attached protection. The missing safety step is confirming the exchange state around a successful live create instead of trusting the create acknowledgement alone.

This change adds a bounded create-time protection verification pass. It takes a pre-create position snapshot, verifies the post-create exchange state, and only allows emergency close when the open position can be attributed to the just-created entry within v1 rules.

## What Changes

- Before live create, when post-create verification is enabled, Abi queries a pre-create position snapshot for the signal symbol.
- If the pre-create position is already open/non-zero, Abi does not block the normal guarded create solely because of that snapshot, but emergency close is disabled for this verification result because the position cannot be safely attributed to the just-created entry.
- If the pre-create position query fails, Abi does not execute the live create; it returns `exchange_query_failed` with action `none` so v1 never creates an order that it cannot safely verify.
- After successful live entry create, Abi runs a short retrying verification procedure.
- Abi queries the pending entry order by its deterministic `orderLinkId`.
- Abi queries the post-create position for the signal symbol.
- If no position is open and the pending entry order is found, the state is reported as `pending_order_verified`.
- If the pre-create snapshot was zero/absent and the post-create position is open, Abi treats that position as newly opened in the scope of this v1 check.
- If that newly opened position has a requested stop loss, Abi obtains the current market price and evaluates the stop breach rule.
- If the newly opened position has already breached the requested stop, Abi sends a guarded market reduce-only emergency close.
- If emergency close fails, Abi reports `emergency_close_failed`, journals operator-safe failure metadata, and does not retry forever or send blind repeated closes.
- If the newly opened position has a requested stop loss and the stop is not breached, Abi reports `position_open_stop_not_breached`. v1 does not prove that exchange-side protection is active.
- If a position is open but the signal was entry-only with no requested stop loss, Abi reports `position_open_no_stop_requested` and does not close the position solely because no stop was requested.
- `POST /signals` live responses include a `protectionCheck` result with operator-oriented diagnostics and no secrets.
- Append-only journal events record the protection check start/completion, query failures, emergency close success, and emergency close failure.

Exact `ProtectionCheckStatus` values for v1:

- `not_run_dry_run`
- `pending_order_verified`
- `pending_order_not_found`
- `pre_existing_position_found`
- `position_open_no_stop_requested`
- `position_open_stop_not_breached`
- `position_open_stop_breached`
- `emergency_close_sent`
- `emergency_close_failed`
- `unsafe_manual_required`
- `exchange_query_failed`

Non-goals for v1:

- no continuous watcher, timer, daemon, or restart recovery;
- no automatic repair through `/v5/position/trading-stop`;
- no post-amend verification;
- no partial take-profit or limit TP/SL;
- no sizing changes;
- no mainnet enablement;
- no bbb strategy logic, indicators, or new signal types;
- no management of long-existing positions outside the immediate create-time flow.

## Capabilities

### New Capabilities

- `post-create-protection-verification`: captures a pre-create position snapshot, verifies the exchange state after successful live entry creation, and sends a guarded emergency close only when a newly opened protected position has already breached its requested stop.

### Modified Capabilities

- None.

## Impact

- Runtime flow: `POST /signals` live create path gains a pre-create position snapshot and a post-create verification step.
- API response: live create responses include `protectionCheck`; dry-run responses do not query Bybit and return `not_run_dry_run`.
- Services: new protection service and pure decision logic under `src/services/protection/`.
- Exchange adapter: reuse or add methods for pre/post position lookup, query-by-link-id, market price lookup, and guarded reduce-only market close.
- Journal: append protection check and emergency-close success/failure events while preserving existing intent history semantics.
- Safety: emergency close remains behind the existing live guard; mainnet live execution stays blocked; blind close is forbidden.
- Recovery/idempotency: v1 is a bounded synchronous check tied to one create flow, not a lifecycle engine, watcher, or repair daemon.
