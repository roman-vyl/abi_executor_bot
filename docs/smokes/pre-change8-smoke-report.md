# Pre-Change 8 smoke campaign report

Branch: `integration/change7-current-design`
Report started: 2026-08-19 (UTC), against the live BBB Demo stack (`bbb_stack`, containers up 3 days at
campaign start: `strategy-runtime`, `abi`, `strategy-engine`, `market-data-service`, all `healthy`).

**Status: STOPPED at Phase A. A pre-existing, severe production blocker was found on the very first
baseline check, before any new smoke work was introduced.** Per the campaign's own rule ("stop at the
first new failure boundary, collect evidence, report — do not fix"), no further phases (B–F) were
attempted. No production code, guards, or Runtime contracts were touched. No new Demo trades were placed.

## 1. Current production regression (Phase A) — BLOCKED

**Goal:** prove a genuine MDS closed bar flows Runtime → Engine → ABI → Bybit Demo end-to-end, unchanged
by Changes 1–7, using the stack's existing live strategies (no manual webhook needed — two strategies are
already `enabled: true` and trading organically: `eth-ema50-smoke` on `ETHUSDT.P`/5m,
`btc-ema50-smoke`/`ema_pullback:53a32ecec5d565b3ac58eec0` on `BTCUSDT.P`/5m).

**Finding: the production pipeline has been fully stalled for ~39 hours, since before this smoke campaign
and before Change 7's own work began.**

- Last real ABI operation of any kind (`entry_package`/`open_position`) across the entire stack:
  `2026-08-18T04:41:39.065Z` — an `entry_package` create attempt for
  `ema_pullback:53a32ecec5d565b3ac58eec0` / trade_cycle `76d30c85-ed76-4748-a89a-fa69c2afd207`, which
  itself failed with `outcome: "internal_error"`.
- Since that moment, ABI has performed **zero** entry-package or protection operations. The only ABI
  activity in the logs since then is a continuous `GET /v1/strategy-instances/.../trade-cycles/.../
  recovery-state` poll loop from Runtime, for exactly two `(strategy_instance_id, trade_cycle_id)` pairs —
  which are exactly the two currently-`enabled` strategy instances' own stuck cycles:
  - `ema_pullback:243bcad65efa36d995d0830c` / `c7fd0188-1731-4d80-9dc5-fcd57bc14d2e` (ETHUSDT, long,
    created `2026-08-17T14:36:25.795Z`)
  - `ema_pullback:53a32ecec5d565b3ac58eec0` / `76d30c85-ed76-4748-a89a-fa69c2afd207` (BTCUSDT, short,
    created `2026-08-18T04:41:38.828Z`)
- Every one of these `recovery-state` calls returns `500 Internal Server Error` (ABI's own structured
  log: `"outcome":"internal_error"`). Count over the last 40h: **7,878 failed calls**. Duration
  distribution: min 2648ms, p50 3167ms, **max 60,652ms** — individual calls occasionally take a full
  minute, suggesting an internal query (likely an exchange round-trip) is itself slow or intermittently
  rate-limited on top of always failing.
- Root-cause hint (read-only inspection, `src/services/entryCycleRecovery/
  entryCycleRecoveryResolutionService.ts` and `src/correlation/entryPackageExecutionRecord.ts`): both
  stuck correlation records carry `"status":"unknown"`, `"order_id":null`, `"pending_action":"create"`.
  `RecoveryState` is a closed enum (`entry_order_live | position_open | terminal_without_fill |
  terminal_after_fill`) and the resolution service's branches key off `record.status` values like
  `terminal_closed`/`found`/`not_found`/`query_failed` — there is no visible branch for a durable
  `"unknown"` status, consistent with an unhandled-case fall-through landing in the generic
  `internal_error` catch. **Not confirmed by a stack trace** (ABI's structured logger does not emit the
  underlying exception for this outcome) — this is a hypothesis from code inspection, not a proven cause,
  and is offered only as a starting point for whoever triages it. No fix was attempted per the campaign's
  own rule.
- Runtime itself is healthy and receiving genuine closed bars the whole time (`POST /v1/webhooks/
  closed-bar` → `200 OK`, arriving on schedule) — the blockage is entirely downstream, in the
  Runtime→ABI recovery handshake for these two specific pre-existing trade cycles. MDS/Runtime dispatch is
  not implicated.
- **This predates Change 7's own work.** The stuck cycles were created `2026-08-17`/`2026-08-18`; Change 7
  rework/review-fix/archive commits on this branch are all dated `2026-08-19`. This is not a regression
  introduced by Changes 6/7 — it is a pre-existing condition the campaign's baseline check happened to
  surface.
- **No current exchange residue from the stuck cycles.** Both correlation records show `order_id: null`.
  That field alone does **not** prove that the ambiguous create never reached Bybit; see the forensic
  appendix below for the required exact-`orderLinkId` lookup. A read-only Demo query at the time of this
  report confirms:
  `ETHUSDT: 0 active orders, 0 open positions`; `BTCUSDT: 0 active orders, 0 open positions`. The blocker
  is a Runtime↔ABI state-machine/HTTP issue, not a live financial-exposure risk today — but it does mean
  the two currently-enabled strategies have not been able to open a new trade cycle in ~39 hours, and
  every failed poll is wasted load (and, given the up-to-60s duration, plausible incidental exchange API
  pressure) on both services.

**Why this blocks the rest of the campaign as designed.** Phase A's purpose is to establish that the
current production path is healthy before layering B–F's smoke/load work on top. It is not: the two
strategies that would provide the "genuine bar → successful position" baseline are both stuck before ever
reaching ABI's create/confirm path. Proceeding to Phase B (native-Partial multi-owner smoke) or Phase D
(Runtime/Engine load ramp) without this being resolved or explicitly waived would validate against a
stack whose baseline health is already unknown-bad, undermining the evidentiary value of every later
phase.

## 2–7. Not attempted

Phases B (native-Partial multi-owner ABI smoke), C (OCO-after-amend evidence), D (Runtime/Engine
scalability), E (two-bar idempotency stress), and F (10-cycle isolation stress) were not started, per the
campaign's explicit "stop at the first new boundary" rule. No synthetic trade cycles, strategy instance
config folders, or docker-compose overrides were created for this report.

## 8. Blockers / observations

1. **[Blocker, pre-existing, not Change 6/7]** `GET /v1/strategy-instances/{id}/trade-cycles/{id}/
   recovery-state` returns `internal_error` for a correlation record with `status: "unknown"`, apparently
   an unhandled classification case in `entryCycleRecoveryResolutionService.ts`. Has been failing
   continuously since `2026-08-18T04:41:39Z` (~39h at time of writing), blocking both currently-enabled
   production strategy instances from ever opening a new trade cycle. No fix attempted (out of this
   campaign's scope per instruction).
2. **[Observation]** ABI's structured logger records `outcome: "internal_error"` for this operation but
   not the underlying exception/stack trace, which slowed this report's root-cause investigation to a
   code-reading hypothesis rather than a confirmed cause.
3. **[Observation]** Per-call duration up to 60.6s on a failing endpoint is itself a load concern
   independent of the correctness bug — worth checking whether recovery-state resolution has an
   unbounded/very-long timeout on some internal query path.
4. **[Not evaluated]** Whether this same `"unknown"` status class could arise newly under Change 7's own
   (still-inert, non-production) reconciliation code path was not assessed — Change 7's
   `reconcileNativePartial()` is not wired into any production path today, so it cannot be the cause of an
   incident that began before Change 7 existed, but it's worth the eventual Change 8 design confirming
   this status class is excluded/handled before any new write path is activated.

## 9. Recommendation

**BLOCKED_BEFORE_CHANGE8.**

Not because of anything Change 7 introduced — the evidence above shows this incident predates Change 7's
work by about a day and a half, and Change 7's own code remains fully inert (no production caller). The
block is that **Phase A itself cannot be completed**: the production baseline this campaign was supposed
to certify is not currently healthy, so there is no clean baseline to certify Changes 1–7 against, and no
sound basis yet to run the heavier Phase B–F smoke/load work on top of a stack in this state.

**Suggested next step (not performed here, needs separate agreement per your instructions):** triage and
fix the `recovery-state` `"unknown"`-status handling gap (or otherwise clear/reset the two stuck
correlation records) as its own piece of work, confirm the two enabled strategies resume normal
create/confirm/position activity on a subsequent genuine closed bar, and only then resume this campaign
starting from Phase A.

## Cleanup verification

No new state was created by this report. Pre-existing stuck cycles were read-only inspected, not
modified. Demo residue check (this report, Phase A investigation only):

| Symbol  | Active orders | Open positions |
|---------|---------------|-----------------|
| ETHUSDT | 0             | 0               |
| BTCUSDT | 0             | 0               |

## Appendix A — forensic investigation of the two stuck CREATE cycles

Investigation performed `2026-08-20` on branch `integration/change7-current-design`, baseline HEAD
`d347323e3363556c34d31a594dbcb2c35c2e9598`. The exchange inspection used signed **GET-only** requests
to Bybit Demo (`https://api-demo.bybit.com`) with the canonical local secret source. No secret,
signature, or credential value was logged. No Bybit write endpoint was called.

### A.1 Durable ABI correlation records

The JSONL repository contains the provisional record followed by the transition to `unknown` for each
cycle. Fields not shown below are unchanged between the two rows.

#### ETHUSDT

```json
{
  "strategy_instance_id": "ema_pullback:243bcad65efa36d995d0830c",
  "trade_cycle_id": "c7fd0188-1731-4d80-9dc5-fcd57bc14d2e",
  "order_link_id": "abi-ep-2ece167a9819694a6130",
  "order_id": null,
  "status": "unknown",
  "pending_action": "create",
  "desired_entry": {
    "side": "long",
    "source_plan_bar_open_time_ms": 1786977000000,
    "planned_entry_price": "1900.6558506776273",
    "initial_stop_price": "1859.3629935347699",
    "initial_take_price": "1941.9487078204847",
    "locked_exit_profile": "neutral"
  },
  "calculated_quantity": "0.01",
  "exchange_symbol": "ETHUSDT",
  "exchange_category": "linear",
  "early_execution_observation": null,
  "binding_history": [],
  "created_at": "2026-08-17T14:36:25.795Z",
  "updated_at": "2026-08-17T14:36:26.034Z"
}
```

The preceding provisional row was created at the same `created_at`/`updated_at`
`2026-08-17T14:36:25.795Z` with `status:"pending_create"`. Thus the durable identity existed before
dispatch and the transition `pending_create → unknown` took 239 ms.

#### BTCUSDT

```json
{
  "strategy_instance_id": "ema_pullback:53a32ecec5d565b3ac58eec0",
  "trade_cycle_id": "76d30c85-ed76-4748-a89a-fa69c2afd207",
  "order_link_id": "abi-ep-6b7261720b19351d3ebb",
  "order_id": null,
  "status": "unknown",
  "pending_action": "create",
  "desired_entry": {
    "side": "short",
    "source_plan_bar_open_time_ms": 1787027700000,
    "planned_entry_price": "64174.15110988302",
    "initial_stop_price": "64676.65110988304",
    "initial_take_price": "63671.65110988301",
    "locked_exit_profile": "neutral"
  },
  "calculated_quantity": "0.001",
  "exchange_symbol": "BTCUSDT",
  "exchange_category": "linear",
  "early_execution_observation": null,
  "binding_history": [],
  "created_at": "2026-08-18T04:41:38.828Z",
  "updated_at": "2026-08-18T04:41:39.064Z"
}
```

The preceding provisional row was created at the same `created_at`/`updated_at`
`2026-08-18T04:41:38.828Z` with `status:"pending_create"`. The transition took 236 ms.

### A.2 ABI request timeline and exact failure boundary

| Stage | ETH | BTC |
|---|---:|---:|
| ABI operation start | `14:36:25.217Z` | `04:41:38.360Z` |
| provisional durable save | `14:36:25.795Z` (+578 ms) | `04:41:38.828Z` (+468 ms) |
| durable `unknown` save | `14:36:26.034Z` (+239 ms) | `04:41:39.064Z` (+236 ms) |
| ABI operation failure / HTTP 500 | `14:36:26.036Z` (+819 ms total) | `04:41:39.065Z` (+705 ms total) |

Current implementation saves `pending_create`, constructs the order payload, and invokes
`bybit.createOrder()`. Its catch branch persists the same record as `status:"unknown"` and returns
`internal_error`. Therefore the durable sequence proves that an exception escaped from the
`createOrder` transport/response path before ABI could decode and persist `orderId`. No realtime or
history confirmation call is reachable in that initial catch path, and none appears in the logs.

The structured ABI log retained only the public boundary:

```json
{"event":"operation_failed","operation":"put_entry_package","outcome":"internal_error","duration_ms":819.031959}
{"event":"operation_failed","operation":"put_entry_package","outcome":"internal_error","duration_ms":705.229125}
```

It did **not** retain the thrown message, stack, HTTP status, Bybit `retCode`, or response body. Searches
in each T−10m/T+10m window found no timeout, rate-limit, transport, exception, or Bybit-response event.
ABI's configured request timeout is 10,000 ms; a failure only 236–239 ms after dispatch does not look
like expiry of that client timeout, but it does not distinguish an immediate transport failure, HTTP
failure, or Bybit application rejection. The exact exception is no longer recoverable from these logs.

`order_id:null` consequently means only “ABI did not persist a decoded acknowledgement”; it does not
mean “the request did not reach Bybit.” The exact stored `order_link_id` inspection in A.4 is the
exchange-side evidence required for the ambiguous write.

### A.3 Runtime cause bar, request, and recovery transition

The genuine closed bar that dispatched ETH had `openTime=1786977000000`; Runtime recorded
`strategy_cycle_dispatch_failed` at `2026-08-17T14:36:26.037241Z` with
`ABI entry-package public error: internal_error`. BTC was dispatched by the genuine bar
`openTime=1787027700000` and failed at `2026-08-18T04:41:39.066116Z` with the same public error. The
corresponding orchestration summaries were emitted at `.038599Z` and `.067859Z`, each with one attempted
and one failed cycle. Runtime received ABI HTTP 500 in both cases; there is no Runtime-side request
timeout evidence.

Runtime does not log the request body. The following bodies are reconstructed from the durable ABI
record and Runtime's deterministic bridge/codec, not quoted from a raw HTTP-body log:

```json
{"ticker":"ETHUSDT.P","desired_entry":{"side":"long","source_plan_bar_open_time_ms":1786977000000,"planned_entry_price":"1900.6558506776273","initial_stop_price":"1859.3629935347699","initial_take_price":"1941.9487078204847","locked_exit_profile":"neutral"},"risk_multiplier":"1"}
{"ticker":"BTCUSDT.P","desired_entry":{"side":"short","source_plan_bar_open_time_ms":1787027700000,"planned_entry_price":"64174.15110988302","initial_stop_price":"64676.65110988304","initial_take_price":"63671.65110988301","locked_exit_profile":"neutral"},"risk_multiplier":"1"}
```

Runtime persists `pending_entry_recovery` immediately before calling ABI. That state save has no
separate timestamped journal event, so its precise time cannot be recovered; it is bounded by ABI
operation start and Runtime's dispatch-failure event. The first observed recovery calls started at
`14:36:50.545Z` (ETH) and `04:41:46.441Z` (BTC), failing after 3379.760 ms and 2921.877 ms respectively.
Subsequent recovery-state calls repeated continuously.

### A.4 Read-only Bybit Demo history reconstruction

Signed queries were scoped by category and symbol. For ETH the queried window was
`2026-08-17T14:26:25.795Z`–`14:46:25.795Z`; for BTC it was
`2026-08-18T04:31:38.828Z`–`04:51:38.828Z`. For **both** symbols:

- `/v5/order/history` returned `[]` for the complete window;
- `/v5/execution/list` returned `[]` for the complete window;
- `/v5/position/closed-pnl` returned `[]` for the complete window;
- a separate history lookup by the exact stored `orderLinkId` returned `[]`;
- no order found in broader history had a lifecycle crossing the target timestamp.

These are clean successful empty API responses, not a decoder/query ambiguity: the same broader queries
returned 45 orders / 44 executions for ETH and 23 orders / 29 executions for BTC. In particular, all
requested candidate classes — other `abi-*`, empty/different `orderLinkId`, manual/spike, TP/SL child,
and reduce-only — are absent from both exact windows, so there are no per-order rows to enumerate there.

Nearest prior exchange evidence:

| Symbol | Time | orderId / orderLinkId | Order | Fill / position evidence |
|---|---|---|---|---|
| ETH | `2026-08-17T14:16:25.681Z` | `9167462a-4bfa-42da-9bbd-e1a5ad469ca5` / `""` | Sell Market, Filled, qty/cum `0.01`, reduceOnly `true`, `CreateByUser` | execution `45bb3b03-a223-4fc7-a9e2-ef558fb2db72`, closedSize `0.01`; closed-PnL says entry `1900.66`, exit `1902.76` |
| ETH | `2026-08-17T14:03:02.847Z` fill | `282751e0-9bd9-41d3-8ce7-a77e12cd2190` / `abi-ep-d067a05d0c19c9fdb7fc` | Buy conditional Market, Filled, qty/cum `0.01`, trigger `1900.68`, reduceOnly `false`, `stopOrderType=Stop`, `CreateByStopOrder`, `tpslMode=Full` | opened the same `0.01` later fully closed above |
| BTC | `2026-08-18T00:56:38.798Z` | `546354ed-266c-46ec-91ff-eac05ab21a15` / `""` | Sell Market, Filled, qty/cum `0.001`, reduceOnly `true`, `CreateByUser` | execution `d3bbdfd3-4201-4077-abbd-04bf9516029e`, closedSize `0.001`; closed-PnL says entry `64361`, exit `64331.2` |
| BTC | `2026-08-18T00:41:47.710Z` fill | `b07bd422-8555-4e13-a780-9f1d37e9d37b` / `abi-ep-3b57b32be6645d1793a0` | Buy conditional Market, Filled, qty/cum `0.001`, trigger `64361`, reduceOnly `false`, `stopOrderType=Stop`, `CreateByStopOrder`, `tpslMode=Full` | opened the same `0.001` later fully closed above |

Thus ETH's preceding physical exposure was fully closed about 20 minutes before the stuck CREATE; BTC's
was fully closed about 3h45m before it. There are no intervening executions through either target
timestamp. Bybit does not provide a point-in-time position snapshot through these queried endpoints, so
the historical position statement is a reconstruction, not a direct timestamped position row. The
matched full-size reduce-only closes, closed-PnL evidence, absence of later executions, and absence of an
order lifecycle crossing T all support flat state at T. Current read-back is also flat (`size:"0"`) with
no realtime orders for both symbols.

The nearest later ETH records are explicitly named spikes, but occurred the following day, not in the
incident window: `abi-spike-p-msyq43szb39725` at `2026-08-18T13:53:58.968Z` and
`abi-amend-p-msyu520u6f9f62` at `2026-08-18T15:46:32.939Z`. They cannot have triggered the ETH failure.
No later BTC order is present in the retained broader result.

### A.5 Direct answers

| Question | ETH | BTC |
|---|---|---|
| A. Foreign/manual/spike order active at T? | **No evidence; reconstructed no.** Empty complete order window and no lifecycle crossing T. | **No evidence; reconstructed no.** Same evidence. |
| B. Physical position already open at T? | **No evidence; reconstructed flat.** Prior `0.01` exposure fully closed 20m before. | **No evidence; reconstructed flat.** Prior `0.001` exposure fully closed 3h45m before. |
| C. Position side versus desired entry? | Not applicable; reconstructed flat. Desired side was long. | Not applicable; reconstructed flat. Desired side was short. |
| D. Rate-limit / timeout / transport instability? | No raw evidence. Immediate create-path exception class is unknown. | No raw evidence. Immediate create-path exception class is unknown. |
| E. Stored orderLinkId in Bybit history now? | Clean `not_found` (`[]`) for `abi-ep-2ece167a9819694a6130`; no final exchange status exists to report. | Clean `not_found` (`[]`) for `abi-ep-6b7261720b19351d3ebb`; no final exchange status exists to report. |

The exact-link lookup materially reduces the ambiguous-write possibilities: there is now no retained
Bybit order record for either id. It still cannot reconstruct whether Bybit briefly received and rejected
or lost an order before durable history was formed, so it must not be rewritten as proof that dispatch
never crossed the network boundary.

### A.6 Separate trigger and liveness conclusions

**TRIGGER.** Proven: after the provisional identity was durably saved, `bybit.createOrder()` (including
its HTTP/Bybit response-reading path) threw within 236–239 ms, before ABI persisted an `orderId` or ran
confirmation. The specific cause — Bybit rejection, HTTP failure, or transport failure — is **NOT
PROVEN** because the exception/response was not logged. Parallel/manual/spike orders and pre-existing
same-symbol positions are not supported as the trigger: the exchange reconstruction shows neither at
either timestamp.

**LIVENESS.** Runtime had already durably saved `pending_entry_recovery`; the ABI 500 left that marker in
place, and Runtime's orchestrator deliberately gives recovery precedence over new genuine-bar cycles.
Each recovery attempt queries the exact entry identity in realtime and history three times. For a clean
absence both queries classify the order as `not_found`; `resolveRecoveryState()` intentionally has no
terminal result for `not_found`, retries three times with 300 ms gaps, then returns `internal_error`.
Consequently Runtime never receives one of the four terminal/recoverable states needed to clear the
marker, so the loop is self-sustaining. This is a fail-closed ambiguity policy, not an exception caused
merely by `record.status:"unknown"`; the earlier report's unhandled-`unknown` hypothesis is superseded by
this code-path and exchange evidence.

### A.7 Forensic scope and repository integrity

No production source, OpenSpec artifact, master plan, Runtime state, ABI correlation data, or exchange
state was modified. The only repository change is this report appendix and the correction of its earlier
invalid `order_id:null` inference.
