## Why

Abi already handles the placement layer for bbb signals: it can create, query, amend, and cancel Bybit demo/testnet entry orders with optional attached protection. The missing safety step is confirming the exchange state immediately after a successful live create instead of trusting the create acknowledgement alone.

This change adds a bounded post-create protection verification pass so operators can see whether the entry order is pending, whether a position already opened, and whether an already-open protected position has crossed its requested stop.

## What Changes

- After a successful live entry create, Abi runs a short retrying verification procedure.
- Abi queries the pending entry order by its deterministic `orderLinkId`.
- Abi queries the current position for the signal symbol.
- If no position is open and the pending entry order is found, the state is reported as verified.
- If a position is open and the intent requested a stop loss, Abi obtains the current market price and evaluates the stop breach rule.
- If a position is open and the current price has already breached the requested stop, Abi sends a guarded market reduce-only emergency close.
- If a position is open, a stop was requested, and protection cannot be confirmed but the stop has not been breached, Abi reports an unsafe/manual-required status without attempting repair.
- If a position is open but the signal was entry-only with no requested stop loss, Abi reports that state and does not close the position solely because no stop was requested.
- `POST /signals` live responses include a `protectionCheck` result with operator-oriented diagnostics and no secrets.
- Append-only journal events record the protection check start/completion, failures, and any emergency close action.

Non-goals for v1:

- no continuous watcher, timer, daemon, or restart recovery;
- no automatic repair through `/v5/position/trading-stop`;
- no post-amend verification;
- no partial take-profit or limit TP/SL;
- no sizing changes;
- no mainnet enablement;
- no bbb strategy logic, indicators, or new signal types;
- no management of long-existing positions outside the immediate post-create flow.

## Capabilities

### New Capabilities

- `post-create-protection-verification`: verifies the exchange state immediately after successful live entry creation and sends a guarded emergency close only when an already-open protected position is beyond its requested stop.

### Modified Capabilities

- None.

## Impact

- Runtime flow: `POST /signals` live create path gains a post-create verification step after successful Bybit create acknowledgement.
- API response: live create responses include `protectionCheck`; dry-run responses do not query Bybit and may return a not-run/preview status.
- Services: new protection service and pure decision logic under `src/services/protection/`.
- Exchange adapter: reuse or add methods for query-by-link-id, position lookup, market price lookup, and guarded reduce-only market close.
- Journal: append protection check and emergency-close events while preserving existing intent history semantics.
- Safety: emergency close remains behind the existing live guard; mainnet live execution stays blocked.
- Recovery/idempotency: v1 is a bounded synchronous check tied to one successful create response, not a lifecycle engine or repair daemon.
