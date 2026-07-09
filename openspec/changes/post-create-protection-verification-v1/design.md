## Context

Abi currently implements the placement layer for bbb signals. `POST /signals` validates the bbb payload, builds an execution plan, creates an intent, and either returns a dry-run preview or sends a guarded Bybit create request. The stable smoke point proves create/query/amend/cancel flows for entry-only, entry-plus-stop, and entry-plus-stop-plus-take signals.

The next safety gap is post-create state verification. Bybit create and amend acknowledgements can be asynchronous: an accepted response is not the same thing as a fully verified exchange state. Immediately after a live create, Abi must check whether the pending entry exists, whether the entry has already filled into a position, and whether an already-open protected position is beyond the requested stop.

This design keeps the check small and synchronous. It is not a watcher and not a repair system.

## Goals / Non-Goals

**Goals:**

- Run a bounded post-create verification step only after successful live entry creation.
- Retry exchange reads briefly to tolerate eventual consistency after Bybit acknowledgement.
- Query the pending entry order by Abi's deterministic entry `orderLinkId`.
- Query the current position by symbol.
- Return a structured `protectionCheck` result in the live `POST /signals` response.
- Append concise journal events for check start, completion, query failure, and emergency close.
- If a position is already open and the current price has breached the requested stop, send a guarded market reduce-only emergency close.
- Keep HTTP routes thin and put decision logic in service/domain code.

**Non-Goals:**

- No continuous watcher, daemon, timer, restart recovery, or lifecycle engine.
- No verification after `PUT /intents/:signalId` in v1.
- No automatic repair through `/v5/position/trading-stop`.
- No partial take-profit, limit TP/SL, or sizing changes.
- No bbb strategy logic, indicators, or new signal types.
- No mainnet live enablement.
- No management of positions that were not created by the immediate successful create flow.

## Decisions

### Add a focused protection service

Create a small service area:

```text
src/services/protection/
  protectionTypes.ts
  protectionDecision.ts
  verifyPostCreateProtection.ts
```

`protectionDecision.ts` should be a pure function over the observed state:

- requested side;
- requested stop loss, if any;
- position presence and size;
- observed market price, if required;
- query outcomes.

`verifyPostCreateProtection.ts` should coordinate exchange calls, retry policy, journal events, and emergency close execution. Routes should continue to call use-cases and serialize responses; they should not make safety decisions.

Alternative considered: put the logic in routes or the Bybit mapper. That would mix transport, mapping, and safety decisions. The protection service keeps the rule testable and prevents the mapper from becoming a policy layer.

### Keep v1 post-create only

The create use-case calls verification only after a successful live create. The verification step is skipped when:

- dry-run returns a preview;
- live create fails;
- the live guard prevents create;
- cancellation or amend flows run.

Dry-run may return `protectionCheck: { status: "not_run_dry_run" }` or an equivalent preview value, but it must not call Bybit.

Alternative considered: also verify after amend. Amend acknowledgement has the same async property, but adding post-amend verification expands the lifecycle scope. v1 focuses on the immediate safety risk after initial placement.

### Use bounded retry for exchange reads

After a successful create acknowledgement, Abi should retry order/position reads briefly, for example a small fixed attempt count with sub-second delay. The exact numbers should live in config or a local constant suitable for unit tests.

The retry is for read-after-write consistency only. It must not become a long-running monitor.

### Decision matrix

If no position is open:

- pending entry order found: `pending_order_verified`, action `none`;
- pending entry order not found after retry: `pending_order_not_found`, action `none`, operator/manual investigation.

If a position is open and no stop loss was requested:

- `position_open_no_stop_requested`, action `none`.
- This is valid for entry-only strategy shape and must not trigger an emergency close.

If a position is open and stop loss was requested:

- Query current market price.
- For long, if `observedPrice <= stopLoss`, status/action proceeds to emergency close.
- For short, if `observedPrice >= stopLoss`, status/action proceeds to emergency close.
- If price has not breached stop, return `position_open_stop_safe` or `unsafe_manual_required` depending on whether protection can be confirmed.
- v1 does not repair missing or unconfirmed attached protection.

If any required exchange query fails:

- return `exchange_query_failed` or `unsafe_manual_required`;
- action `none`;
- never perform a blind close.

### Emergency close stays guarded

Emergency close is allowed only when all are true:

- live mode is allowed by the existing execution guard;
- a position exists;
- the intent requested a stop loss;
- the observed price has already breached that stop;
- a market reduce-only close can be built with safe symbol, side, and quantity.

The close must go through the same guarded execution layer as other live writes. It must not bypass mainnet blocking, credential checks, demo/testnet gates, or `ABI_LIVE_TRADING_ENABLED`.

### Result shape

`ProtectionCheckResult` should include enough data for operator diagnosis without secrets:

- `status`;
- `action`;
- `signal_id`;
- `instance_id`;
- `symbol`;
- `side`;
- `orderLinkId`;
- requested `protection` from the execution plan;
- `orderFound`;
- `positionFound`;
- `positionSize` when available;
- `stopLoss` when available;
- `observedPrice` when queried;
- `reason`;
- retry/attempt metadata;
- `emergencyCloseOrder` when sent.

Suggested statuses:

- `not_run_dry_run`;
- `pending_order_verified`;
- `pending_order_not_found`;
- `position_open_no_stop_requested`;
- `position_open_stop_safe`;
- `position_open_stop_breached`;
- `emergency_close_sent`;
- `unsafe_manual_required`;
- `exchange_query_failed`.

Names may be adjusted during implementation if they remain semantically equivalent.

### Journal behavior

The implementation should append concise events without inventing a large event system:

- `protection_check_started`;
- `protection_check_completed`;
- `protection_check_failed`;
- `emergency_close_sent`.

Journal entries should keep the append-only intent history meaningful and should not contain API secrets.

### Future repair change

Automatic repair through `/v5/position/trading-stop` belongs in a separate change, for example `position-trading-stop-repair-v1` or `protection-repair-v1`. Repair requires careful handling of Bybit account mode, `positionIdx`, Full/Partial TP/SL mode, one-way versus hedge mode, and partial/limit behavior. v1 intentionally stops at verify/report/emergency-close-if-already-breached.

## Risks / Trade-offs

- [Bybit query may not immediately show the new order] → Use bounded retry and return a manual status if not found.
- [The entry may fill between create acknowledgement and order query] → Always query position as well as pending order and branch on position presence.
- [Bybit order query may not echo attached TP/SL fields reliably] → Do not make v1 success depend on TP/SL echo in the pending order response.
- [Price query can fail] → Do not close blindly; return `exchange_query_failed` or `unsafe_manual_required`.
- [Emergency close can be dangerous if guard is bypassed] → Route it through the existing guarded execution layer and keep mainnet blocked.
- [A position without requested stop may be intentional] → Report `position_open_no_stop_requested`; do not close.
- [Synchronous verification adds latency to `POST /signals`] → Keep retry short and bounded; this is an operational safety trade-off, not a watcher.
