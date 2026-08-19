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
- **No exchange residue from the stuck cycles.** Both correlation records show `order_id: null` — neither
  cycle ever reached Bybit. A read-only Demo query at the time of this report confirms:
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
