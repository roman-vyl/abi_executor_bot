## Context

Abi currently implements the placement layer for bbb signals. `POST /signals` validates the bbb payload, builds an execution plan, creates an intent, and either returns a dry-run preview or sends a guarded Bybit create request. The stable smoke point proves create/query/amend/cancel flows for entry-only, entry-plus-stop, and entry-plus-stop-plus-take signals.

The next safety gap is create-time state verification. Bybit create and amend acknowledgements can be asynchronous: an accepted response is not the same thing as a fully verified exchange state. Immediately around a live create, Abi must know whether the symbol already had an open position, whether the pending entry exists after create, whether a new position appeared, and whether that newly opened protected position is already beyond the requested stop.

This design keeps the check small and synchronous. It is not a watcher and not a repair system.

## Goals / Non-Goals

**Goals:**

- Take a pre-create position snapshot before live create when post-create verification is enabled.
- Refuse live create when the pre-create position snapshot query fails, returning `exchange_query_failed` and action `none`.
- Run a bounded post-create verification step only after successful live entry creation.
- Retry exchange reads briefly to tolerate eventual consistency after Bybit acknowledgement.
- Query the pending entry order by Abi's deterministic entry `orderLinkId`.
- Query the post-create position by symbol.
- Attribute an open post-create position to the new create only when the pre-create snapshot was zero/absent.
- Return a structured `protectionCheck` result in the `POST /signals` response.
- Append concise journal events for check start, completion, query failure, emergency close success, and emergency close failure.
- If a newly opened position has breached the requested stop, send a guarded market reduce-only emergency close.
- Keep HTTP routes thin and put decision logic in service/domain code.

**Non-Goals:**

- No continuous watcher, daemon, timer, restart recovery, or lifecycle engine.
- No verification after `PUT /intents/:signalId` in v1.
- No automatic repair through `/v5/position/trading-stop`.
- No proof that exchange-side TP/SL protection is active on the position.
- No partial take-profit, limit TP/SL, or sizing changes.
- No bbb strategy logic, indicators, or new signal types.
- No mainnet live enablement.
- No management of pre-existing or long-existing positions.

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
- pre-create position presence and size;
- post-create position presence and size;
- pending order lookup outcome;
- observed market price, if required;
- query outcomes;
- emergency close outcome, if a close was attempted.

`verifyPostCreateProtection.ts` should coordinate exchange calls, retry policy, journal events, and emergency close execution. Routes should continue to call use-cases and serialize responses; they should not make safety decisions.

Alternative considered: put the logic in routes or the Bybit mapper. That would mix transport, mapping, and safety decisions. The protection service keeps the rule testable and prevents the mapper from becoming a policy layer.

### Use a pre-create position snapshot as the attribution boundary

Emergency close is forbidden unless the position can be attributed to the just-created entry within v1 rules.

Before live create, Abi queries the current position by symbol:

- If the pre-create position is open/non-zero, Abi records `pre_existing_position_found`. The normal guarded create flow continues if otherwise allowed, but this verification result must not perform emergency close because any post-create position cannot be safely attributed to the newly created entry.
- If the pre-create position is zero/absent and the post-create position becomes open/non-zero, v1 treats that position as newly opened after create and may evaluate stop breach.
- If the pre-create position query fails, Abi does not send the live create. It returns `exchange_query_failed` with action `none`. This is the chosen v1 behavior because creating without a reliable attribution baseline would leave emergency close disabled while still adding new exchange state.

Alternative considered: allow create after pre-create query failure but disable emergency close. That keeps placement available but weakens the safety value of this change. v1 chooses the more conservative behavior: no baseline, no live create.

### Keep v1 create-flow only

The create use-case performs:

```text
POST /signals route
  -> parse/validate signal
  -> build ExecutionPlan
  -> create intent
  -> if dry-run:
       return preview with protectionCheck.status = not_run_dry_run
     if live guard blocks create:
       return existing blocked/skipped response, no exchange verification
     if live create path is allowed:
       query pre-create position snapshot
       if snapshot query failed:
         return protectionCheck.status = exchange_query_failed and do not create
       guarded Bybit create
       if create failed:
         return existing failed-create behavior, no post-create verification
       verify post-create order/position state
       maybe send guarded emergency close
       append journal events
       return create response with protectionCheck
```

The verification step is skipped when:

- dry-run returns a preview;
- live create is blocked before the pre-create snapshot;
- live create fails;
- cancellation or amend flows run.

Dry-run must return `protectionCheck.status = not_run_dry_run` and must not call Bybit.

Alternative considered: also verify after amend. Amend acknowledgement has the same async property, but adding post-amend verification expands the lifecycle scope. v1 focuses on the immediate safety risk around initial placement.

### Use bounded retry for post-create exchange reads

After a successful create acknowledgement, Abi should retry order/position reads briefly, for example a small fixed attempt count with sub-second delay. The exact numbers should live in config or a local constant suitable for unit tests.

The retry is for read-after-write consistency only. It must not become a long-running monitor.

### Exact v1 statuses

`ProtectionCheckStatus` is exactly:

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

No implementation-only synonyms should be introduced for v1.

`unsafe_manual_required` is reserved for verified but unresolved states where operator review is required and no more specific v1 status applies. It must never trigger blind emergency close.

### Decision matrix

If pre-create position query failed:

- status: `exchange_query_failed`;
- action: `none`;
- live create: not sent;
- emergency close: forbidden.

If pre-create position is open/non-zero:

- status: `pre_existing_position_found`;
- action: `none`;
- guarded live create: continues if the normal create path is otherwise allowed;
- emergency close: forbidden;
- reason explains that the position cannot be safely attributed to the just-created entry.

If pre-create position is zero/absent and no post-create position is open:

- pending entry order found: `pending_order_verified`, action `none`;
- pending entry order not found after retry: `pending_order_not_found`, action `none`.

If pre-create position is zero/absent and post-create position is open/non-zero with no requested stop loss:

- status: `position_open_no_stop_requested`;
- action: `none`.
- This is valid for entry-only strategy shape and must not trigger an emergency close.

If pre-create position is zero/absent and post-create position is open/non-zero with requested stop loss:

- Query current market price.
- For long, if `observedPrice <= stopLoss`, set `position_open_stop_breached` and attempt emergency close.
- For short, if `observedPrice >= stopLoss`, set `position_open_stop_breached` and attempt emergency close.
- If price has not breached stop, return `position_open_stop_not_breached`, action `none`.
- If price query fails, return `exchange_query_failed`, action `none`.

If emergency close is attempted:

- close accepted/sent: final status `emergency_close_sent`;
- close rejected/guarded/failed: final status `emergency_close_failed`;
- v1 does not retry forever and does not send blind repeated closes.

Important wording: `position_open_stop_not_breached` means only that the observed price has not crossed the requested stop. v1 does not prove that exchange-side active protection exists on the position.

### Emergency close stays guarded

Emergency close is allowed only when all are true:

- pre-create position snapshot was zero/absent;
- post-create position exists;
- live mode is allowed by the existing execution guard;
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
- `preCreatePositionFound`;
- `preCreatePositionSize` when available;
- `orderFound`;
- `postCreatePositionFound`;
- `postCreatePositionSize` when available;
- `stopLoss` when available;
- `observedPrice` when queried;
- `reason`;
- retry/attempt metadata;
- `emergencyCloseOrder` when sent;
- operator-safe `error` metadata when query or close fails.

### Journal behavior

The implementation should append concise events without inventing a large event system:

- `protection_check_started`;
- `protection_check_completed`;
- `protection_check_failed`;
- `emergency_close_sent`;
- `emergency_close_failed`.

Journal entries should keep the append-only intent history meaningful and should not contain API secrets.

### Future repair change

Automatic repair through `/v5/position/trading-stop` belongs in a separate change, for example `position-trading-stop-repair-v1` or `protection-repair-v1`. Repair requires careful handling of Bybit account mode, `positionIdx`, Full/Partial TP/SL mode, one-way versus hedge mode, and partial/limit behavior. v1 intentionally stops at snapshot, verify, report, and emergency-close-if-new-position-is-already-breached.

## Risks / Trade-offs

- [Pre-create position query can fail] → Do not send live create; return `exchange_query_failed`.
- [A position may already exist before create] → Return `pre_existing_position_found`; forbid emergency close because attribution is unsafe.
- [Bybit query may not immediately show the new order] → Use bounded retry and return `pending_order_not_found` if not found and no position exists.
- [The entry may fill between create acknowledgement and order query] → Query post-create position as well as pending order and branch on position presence.
- [Bybit order query may not echo attached TP/SL fields reliably] → Do not make v1 success depend on TP/SL echo in the pending order response.
- [v1 does not prove active protection] → Use `position_open_stop_not_breached`, not “safe”, when price has not crossed the requested stop.
- [Price query can fail] → Do not close blindly; return `exchange_query_failed`.
- [Emergency close can fail] → Return `emergency_close_failed`, journal operator-safe error metadata, and do not retry forever.
- [Emergency close can be dangerous if guard is bypassed] → Route it through the existing guarded execution layer and keep mainnet blocked.
- [A position without requested stop may be intentional] → Report `position_open_no_stop_requested`; do not close.
- [Synchronous verification adds latency to `POST /signals`] → Keep retry short and bounded; this is an operational safety trade-off, not a watcher.
