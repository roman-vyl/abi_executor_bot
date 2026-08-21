# Change 8 multi-spec Demo soak report

## Verdict

`FAIL / BLOCKED`

The campaign stopped at the first new correctness/liveness boundary. Two genuine EMA instances received an unexplained ABI `500 internal_error` before ABI persisted a correlation binding. Runtime then durably retained `pending_entry_recovery`, while every recovery read returned `422 unknown_trade_cycle_binding`. This is a permanent recovery loop in the observed state.

No workaround or production-code change was made. Runtime was stopped to prevent further test work. No manual Bybit create/amend/cancel/close was performed.

## Versions and environment

- Environment: Bybit Demo (`https://api-demo.bybit.com`); the read-only evidence client asserted `BYBIT_ENV=demo` before querying.
- Runtime checkout: `main` at `35fdb4ffa9f2100fecc29f32fc5f2a066ae00ab6`.
- Runtime deployed image ID: `sha256:9eadf2cd40d546806d4bd7b57303a2ef3d82968300e0b81ba701d683a462cde1`.
- Runtime deployed close-client file hash matched the checkout: `c28f633677d593aeefe2a19b7f40674424fa358c17eb037f4fd7ed81e9e37e2d`.
- Runtime → Engine timeout: `180` seconds.
- ABI checkout: `integration/change7-current-design` at `300537f1df6bc7084fd5c1b4d9eb5fce2169934f`.
- ABI deployed image ID: `sha256:ff127611b95a54cc9d6e63713a4c33c5b88157a2916620acd1d0ab4b9a894295`.
- ABI image contains the production source through the live-unfilled fix `71797c9291e9d8c97c03b4a8d9adb050e925d739`; commits through checkout HEAD after that are report-only.
- Strategy Engine checkout: `ci/cicd-v1` at `88e76f7914c9422215c90c8168077c5aa8a8bbdc`; deployed local image ID `sha256:d5ead032d0d5d53093dd307f1baf93b8f574ee22332304e148372fddfe5f1c35`.
- MDS checkout: `ci/cicd-v1` at `4f9bf11cc535fab3af75f7c0bab77201fd7a8810`; deployed image tag commit `758b56f1947fcc3ef00e58a856caa05726c769ae`, image ID `sha256:ccc4264db7e15e3c0715611d09cb1b70824feecdc457dcc011c098634e1819e3`. The deployed MDS commit differs from the current checkout and is reported explicitly rather than treated as identical.
- Before observation, MDS, Runtime, Engine, and ABI were all healthy. After the blocker, only Runtime was intentionally stopped; the other three remained healthy.

## Campaign configuration

Ticker/timeframe: `ETHUSDT.P / 5m`.

Runtime's live catalog convention is flat JSON, not YAML. Six canonical-schema JSON variants were therefore used; isolated catalog validation reported six accepted instances, no invalid entries, and no duplicates. Combined live discovery reported ten files total, eight enabled (the six soak instances plus pre-existing enabled BTC and ETH smoke instances), no invalid entries, and no duplicates.

| EMA | Strategy instance ID | Anchor stack (fast/anchor/slow) |
|---:|---|---|
| 2 | `ema_pullback:c1f6d8a5f3a77c337189ba75` | 1/2/4 |
| 3 | `ema_pullback:cf82c56b082da6e2995e1f63` | 2/3/6 |
| 5 | `ema_pullback:7ece618beed71c6e3410fd48` | 3/5/10 |
| 10 | `ema_pullback:8928d5841bee3fff536e7c59` | 5/10/20 |
| 20 | `ema_pullback:191a4b2e10fd9196971a5004` | 10/20/40 |
| 50 | `ema_pullback:b8ef3f2caf0ea4c80e268b18` | 20/50/100 |

The pre-existing enabled ETH instance `ema_pullback:243bcad65efa36d995d0830c` was listed in advance and left unchanged. Its activity below is classified as non-soak contamination.

## Timeline and counts

- Configuration installed: approximately `2026-08-21T17:23Z`.
- Evidence baseline: `2026-08-21T17:25:24Z`.
- First genuine ETH bar: MDS posted it at `17:25:00Z`, with `open_time_ms=1787332800000`.
- First completed ETH orchestration: `17:35:21.634Z`; selected 7, attempted 7, succeeded 5, failed 2.
- A second genuine ETH bar (`open_time_ms=1787333100000`) began at `17:37:03.366Z`, but Runtime was stopped before it completed.
- Runtime stopped: `2026-08-21T17:37:45Z`.
- Observation duration: about 12 minutes; the required 30–60 minutes was intentionally not reached because the stop rule fired.

Counts attributable to the six soak instances before stop:

- completed genuine ETH bars: 1;
- partially started subsequent genuine ETH bars: 1;
- trade-cycle identities allocated by Runtime: 4;
- ABI-applied CREATEs: 2;
- pre-binding failed CREATE attempts: 2;
- fills: 0;
- materialized native Partial protection pairs: 0;
- protection amends: 0;
- closes: 0;
- maximum simultaneous active soak owners: 2;
- maximum simultaneous active ETH entry owners including the pre-existing ETH instance: 3.

## Cycle evidence

| Instance | Cycle | Result | orderLinkId / orderId | Own fill | Protection | Final durable state |
|---|---|---|---|---:|---|---|
| EMA20 `...71a5004` | `b4695ef1-3198-4e7a-aec1-f400762d60af` | applied | `abi-ep-ac09032d835a6dc02cc2` / `bff049bb-4777-4e6d-9a43-7afaad61994d` | 0 | none | ABI `applied`; Runtime current cycle, no recovery marker |
| EMA50 `...268b18` | `58593956-af12-4513-9815-1d4fc5175d1d` | applied | `abi-ep-32953da78cadce39e46b` / `e302c7f1-c5a0-4b20-ac38-66c52ed1e4c2` | 0 | none | ABI `applied`; Runtime current cycle, no recovery marker |
| EMA2 `...9ba75` | `8ba1f394-c283-4290-8d6b-e93529ea50f1` | `500 internal_error` | none persisted | n/a | none | Runtime pending recovery; ABI binding absent; recovery `422` loop |
| EMA3 `...e1f63` | `19231137-11b8-437d-aeb7-6621499afaf5` | `500 internal_error` | none persisted | n/a | none | Runtime pending recovery; ABI binding absent; recovery `422` loop |
| EMA5 `...fd48` | none | no entry write | n/a | n/a | none | no current cycle/marker |
| EMA10 `...7c59` | none | no entry write | n/a | n/a | none | no current cycle/marker |

The pre-existing ETH instance also organically created cycle `7266ea24-519f-4ce2-b3d6-7f5b37854613`, orderLinkId `abi-ep-51638220e91687f9c232`, orderId `07c19b47-c6f9-4ab3-8ae5-30fd384c21f7`. It is not counted as a soak owner.

## First blocker

### Exact evidence

EMA2:

```text
17:33:53.121Z ABI entry_package operation_started
17:33:53.122Z ABI operation_failed outcome=internal_error duration_ms=1.020167
17:33:53.122Z Runtime PUT .../entry-package -> HTTP 500
17:34:12.550Z ABI recovery_state -> unknown_trade_cycle_binding (HTTP 422)
```

The same recovery result repeated at approximately 30-second intervals (`17:34:42`, `17:35:12`, `17:35:42`, `17:36:12`, `17:36:42`).

EMA3 reproduced the boundary:

```text
17:35:21.631Z ABI entry_package operation_started
17:35:21.632Z ABI operation_failed outcome=internal_error duration_ms=0.7805
17:35:21.632Z Runtime PUT .../entry-package -> HTTP 500
17:35:42.579Z ABI recovery_state -> unknown_trade_cycle_binding (HTTP 422)
```

No record for either exact pair exists in `abi_entry_package_correlation.jsonl`. Therefore the failure is before the provisional durable correlation save and before any attributable Bybit write. Current ABI logging exposes only generic `internal_error`, so the exact internal cause (for example, position-sizing failure versus another pre-save invariant) is **not proven** and must not be guessed.

### Liveness consequence

Runtime durably wrote `pending_entry_recovery` for both cycles. Because ABI has no binding, recovery cannot return an actionable state and repeatedly returns `unknown_trade_cycle_binding`. The markers cannot clear through the current protocol. This is a proven liveness defect distinct from the still-unknown trigger of the pre-binding `500`.

## Read-only Bybit snapshot at the blocker

ETH physical position was flat:

```json
{"symbol":"ETHUSDT","side":"","size":"0","avgPrice":"0","positionIdx":0}
```

Three active same-side conditional Market entries existed, all `Untriggered`, `cumExecQty="0"`, `qty="0.01"`:

```json
{"orderId":"bff049bb-4777-4e6d-9a43-7afaad61994d","orderLinkId":"abi-ep-ac09032d835a6dc02cc2","side":"Buy","orderStatus":"Untriggered","triggerPrice":"2403.13"}
{"orderId":"e302c7f1-c5a0-4b20-ac38-66c52ed1e4c2","orderLinkId":"abi-ep-32953da78cadce39e46b","side":"Buy","orderStatus":"Untriggered","triggerPrice":"2396.71"}
{"orderId":"07c19b47-c6f9-4ab3-8ae5-30fd384c21f7","orderLinkId":"abi-ep-51638220e91687f9c232","side":"Buy","orderStatus":"Untriggered","triggerPrice":"2396.71"}
```

Exact execution queries for the two soak orderLinkIds returned empty lists. No Partial TP/SL children existed because no entry had filled. No attributable orderLinkId was ever persisted for the two failed cycles, and no fourth/fifth ETH order corresponding to them appeared.

## Invariant assessment

- Independent identities: partially demonstrated; two soak and one pre-existing same-side entry orders coexisted with distinct pair and exchange identities.
- Duplicate CREATE: not observed for applied cycles.
- Own fills/protection/close/sibling-close isolation: not reached.
- Legacy Full or shared-scope rejection: not observed in exchange state, but the generic pre-binding failures prevent a successful verdict.
- 4xx/5xx: two ABI entry-package `500`; repeated recovery `422` for both failed cycles.
- Recovery/liveness: failed, as described above.
- Contradictory durable versus Bybit state: none for the two applied cycles. The failed cycles have Runtime markers but no ABI binding; this is the protocol-level liveness contradiction under test.

The principal acceptance case, “owner A closes while owner B remains active,” was not reached.

## Stop and residual state

- `strategy-runtime` was stopped at `17:37:45Z` to halt further test dispatch and recovery polling. Exit status reported by Compose: `Exited (137)` after the explicit stop.
- ABI, Engine, and MDS remained healthy.
- The six test config files remain in the live catalog. An attempted exact removal was rejected by the safety gate because the runbook requires report-first and a separate explicit cleanup decision.
- Two soak entry orders and one pre-existing ETH entry order remain live and unfilled on Bybit Demo.
- ETH physical position remains flat.
- No manual exchange cleanup was performed, preserving evidence as required.
- Before Runtime is restarted, an operator must explicitly decide how to handle the six configs, the two pending recovery markers, and the three live ETH entries. Restarting Runtime unchanged would resume the two `unknown_trade_cycle_binding` recovery loops and may start more test work.

## Forensic appendix: pre-binding `500` root cause

Investigation date: `2026-08-21`. No Runtime process or exchange mutation was used. The original target bar was replayed directly through the read-only Strategy Engine projection endpoint, and the resulting side was evaluated against the exact ABI durable scope state.

### Reconstructed exact entry-package inputs

Both failed Runtime requests used:

```json
{"ticker":"ETHUSDT.P","risk_multiplier":"1"}
```

EMA2 desired entry:

```json
{
  "side": "short",
  "source_plan_bar_open_time_ms": 1787332800000,
  "planned_entry_price": "2405.8847543674137",
  "initial_stop_price": "2483.9561829388426",
  "initial_take_price": "2327.813325795985",
  "locked_exit_profile": "neutral"
}
```

EMA3 desired entry:

```json
{
  "side": "short",
  "source_plan_bar_open_time_ms": 1787332800000,
  "planned_entry_price": "2407.2631211278012",
  "initial_stop_price": "2485.33454969923",
  "initial_take_price": "2329.1916925563723",
  "locked_exit_profile": "neutral"
}
```

At both attempts, the authoritative latest-record set for `linear:ETHUSDT` contained three active owners, all `long`:

```json
[
  {"strategy_instance_id":"ema_pullback:191a4b2e10fd9196971a5004","trade_cycle_id":"b4695ef1-3198-4e7a-aec1-f400762d60af","status":"applied","side":"long"},
  {"strategy_instance_id":"ema_pullback:243bcad65efa36d995d0830c","trade_cycle_id":"7266ea24-519f-4ce2-b3d6-7f5b37854613","status":"applied","side":"long"},
  {"strategy_instance_id":"ema_pullback:b8ef3f2caf0ea4c80e268b18","trade_cycle_id":"58593956-af12-4513-9815-1d4fc5175d1d","status":"applied","side":"long"}
]
```

Running the production `classifyScopeAdmission()` against this exact set and either failed command's `requestedSide="short"` returned:

```json
{"classification":"opposite_side"}
```

### Exact failing boundary

The failure is `EntryPackageApplicationService.createOrder()`'s scope admission:

1. `findActiveRecordsForScope("linear", "ETHUSDT")` returns the three active `long` records.
2. `classifyScopeAdmission(activeRecords, command, "short")` returns `opposite_side` (`entryPackageApplicationService.ts:373-374`, classifier return at line 890 in commit `b590853`).
3. The scope-lock callback returns `"conflict"` at lines 381-382.
4. `createOrder()` returns `internalErrorResult()` at lines 395-400.

Consequently, line 390 (`correlationRepository.save(provisional)`) is not reached. The mapper and `executeEntryOrder()`/Bybit create path below line 403 are also not reached. This exactly explains all original evidence: approximately 1 ms duration, no correlation line, no persisted orderLinkId/orderId, and no corresponding Bybit order.

The existing service-level test `opposite-side and corrupt scope ownership fail before correlation or exchange write` independently proves the same path: the opposite-side request returns internal error, the fake Bybit create-call count does not increase, and the requesting pair remains absent from the repository. The full ABI suite passed during the forensic pass: 672 tests, 672 passed.

### Why EMA20/EMA50 passed

EMA20 and EMA50 each produced a `long` desired entry on the same bar. Their requested side matched every already-active ETH owner, so admission classified the scope as `empty` for the first owner and `same_side` for subsequent owners. Their provisional records were saved and their exchange creates proceeded. EMA2 and EMA3 produced `short`, so they hit the opposite-side veto. The differing outcome is side-based, not EMA-period handling, quantity calculation, mutex failure, or repository failure.

### Root-cause classification

- The exchange-safety decision to reject an opposite-side owner is intentional and correct.
- The primary `500` is therefore not a multi-owner implementation defect. The same result occurs with one active opposite-side owner; multi-spec operation merely made opposing strategy directions occur naturally.
- The correctness/liveness defect is the protocol classification: a deterministic pre-write scope rejection is exposed as generic `500 internal_error`. Runtime must conservatively treat that response as a potentially ambiguous APPLY and stores a recovery marker, but ABI has deliberately persisted no binding, so recovery can only return `unknown_trade_cycle_binding`.
- The previously reported recovery loop is a consequence of this classification mismatch. It was not changed in this investigation.

### Minimal correction direction (not implemented)

Introduce a coordinated, typed, explicitly non-ambiguous entry-package rejection for the pre-write opposite-side scope veto. ABI should return that outcome only when the scope-lock proof rejects before `save(provisional)` and before any exchange dispatch. Runtime should decode it as a deterministic rejected/no-write attempt and must not create `pending_entry_recovery` for it.

This is preferable to weakening opposite-side admission, fabricating an ABI binding, or treating arbitrary `unknown_trade_cycle_binding` as proof of no write. Exact public status/code and Runtime state transition require a small coordinated contract change. No correction was applied here.

## Cleanup and LONG-only preparation

Cleanup/preparation date: `2026-08-21`. This section supersedes the residual-state bullets recorded at the original stop; it does not change the original `FAIL / BLOCKED` verdict.

### Pre-cleanup ownership inventory

Runtime remained stopped. ETH was physically flat and the following three exact orders were the complete active `ETHUSDT` set:

| Owner | Cycle | orderLinkId | orderId | State |
|---|---|---|---|---|
| soak EMA20 `ema_pullback:191a4b2e10fd9196971a5004` | `b4695ef1-3198-4e7a-aec1-f400762d60af` | `abi-ep-ac09032d835a6dc02cc2` | `bff049bb-4777-4e6d-9a43-7afaad61994d` | `Untriggered`, qty `0.01`, fill `0` |
| soak EMA50 `ema_pullback:b8ef3f2caf0ea4c80e268b18` | `58593956-af12-4513-9815-1d4fc5175d1d` | `abi-ep-32953da78cadce39e46b` | `e302c7f1-c5a0-4b20-ac38-66c52ed1e4c2` | `Untriggered`, qty `0.01`, fill `0` |
| pre-existing `eth-ema50-smoke.json`, `ema_pullback:243bcad65efa36d995d0830c` | `7266ea24-519f-4ce2-b3d6-7f5b37854613` | `abi-ep-51638220e91687f9c232` | `07c19b47-c6f9-4ab3-8ae5-30fd384c21f7` | `Untriggered`, qty `0.01`, fill `0` |

The third order's ownership was proven by both the Runtime registered snapshot (`source_path=eth-ema50-smoke.json`) and the matching ABI correlation record, so it was eligible for the requested test-state cleanup.

No protection child existed for any of the three orders. Exact execution queries were empty and aggregate ETH position size was zero.

The two failed cycles still had no ABI correlation record. Their deterministic generation-1 identities were reconstructed solely to make exact exchange reads:

- EMA2: `abi-ep-81b357731b1b9d740fae`;
- EMA3: `abi-ep-0e4ccf3def25b40595cd`.

Both were absent from realtime/history and had empty exact execution lists. Together with the proven pre-save `opposite_side` boundary, this confirms that neither failed cycle caused an exchange write.

### Mutations and cleanup result

Three pair-scoped ABI `PUT .../entry-package` requests with `desired_entry=null` were sent for the exact bound cycles above. Each returned HTTP 200 `entry_package_absent`. Read-back showed the same three order IDs in history as `Deactivated`, `cumExecQty="0"`, `leavesQty="0"`; active ETH orders became empty. No account-wide or symbol-wide cancel was used.

Because there was no exposure or materialized protection, cleanup sent no protection cancellation and no reduce-only close.

With Runtime still stopped, its canonical fsync-backed append-only state repository was used to append cleared snapshots for:

- EMA20 and EMA50 soak current cycles after their matching ABI `EntryPackageAbsent` confirmations;
- the proven pre-existing ETH smoke current cycle after its matching ABI confirmation;
- EMA2 and EMA3 pending recovery markers after proving no ABI binding and no exchange write.

Final read-back:

- all six prior soak instances: `current_trade_cycle=null`, `pending_entry_recovery=null`;
- pre-existing ETH smoke instance: `current_trade_cycle=null`, `pending_entry_recovery=null`;
- three ABI bindings: durable `status=absent`, null entry identity and no pending action;
- Bybit ETH active orders: `[]`;
- Bybit ETH position: flat (`size="0"`);
- soak protection children: none;
- exact executions for all three former bindings and both failed prospective identities: none.

### Prepared LONG-only catalog

The supported Strategy Engine configuration mechanism was used without code changes:

```json
{"trade_sides":{"enabled":["long"]}}
```

The six files remain `soak-ema2.json`, `soak-ema3.json`, `soak-ema5.json`, `soak-ema10.json`, `soak-ema20.json`, and `soak-ema50.json`. Because side eligibility is part of semantic identity, their instance IDs changed:

| EMA | Prepared LONG-only instance ID |
|---:|---|
| 2 | `ema_pullback:fe2d8446d4b917803a3f1115` |
| 3 | `ema_pullback:9b45068fd5d1f833a82ba5a5` |
| 5 | `ema_pullback:1a4edf9e70cbaa92620a6ff6` |
| 10 | `ema_pullback:2a008f42491af59f78220d62` |
| 20 | `ema_pullback:75a7a31b44c1d79f560cd753` |
| 50 | `ema_pullback:54695e606ce7f06cb43b39a4` |

Combined live-catalog validation (without starting Runtime) reported:

```text
scanned=10 accepted=10 soak_accepted=6 invalid=0 duplicates=0
```

All six accepted soak deployments decode `trade_sides.enabled` as the exact tuple `("long",)`. Strategy Engine constructs side-specific entry candidates only for enabled sides; its existing range test proves a LONG-only spec exposes only the `long` potential-entry key.

As an incident-specific regression, EMA2 and EMA3 were re-evaluated read-only on target bar `1787332800000`, where their prior dual-side configs produced SHORT entries. Both LONG-only configs returned HTTP 200:

```json
{"desired_entry":null}
```

Thus a disabled SHORT is suppressed rather than relabelled as LONG. The prepared configs can emit only LONG or no entry. Runtime was not started and no new soak began.

The prior stop is now precisely classified as an expected opposite-side admission veto, not a same-side ownership failure. The generic `500` followed by a permanent recovery marker remains a deferred known contract/liveness issue and was not fixed during cleanup.

## Attempted LONG-only soak start

Attempt date: `2026-08-21`.

Runtime was started for a full LONG-only soak after the cleanup above, then stopped before any new ABI/exchange write completed. The stack state at start was:

- ABI branch/HEAD: `integration/change7-current-design` at `26618391b324ab5958f685d4f526639b30004ef5`;
- ABI, MDS, and Strategy Engine healthy;
- Runtime initially absent/stopped, then started healthy and later stopped again;
- live catalog files `soak-ema2.json`, `soak-ema3.json`, `soak-ema5.json`, `soak-ema10.json`, `soak-ema20.json`, and `soak-ema50.json` all contained `trade_sides.enabled=["long"]`.

MDS delivered genuine closed-bar webhooks after Runtime came up. Runtime journal contains the fresh start event:

```json
{"event_type":"committed_bar_orchestration_started","occurred_at":"2026-08-21T18:24:59.981135+00:00","payload":{"instrument":"ETHUSDT.P","open_time_ms":1787336400000,"timeframe":"5m"}}
```

The attempt was stopped because Runtime's durable registered-instance state did not match the prepared LONG-only catalog. Latest state per soak-related instance still contained the old dual-side registrations for EMA2/EMA3/EMA10/EMA20/EMA50 and the previous ETH smoke instance:

```text
soak-ema2  ema_pullback:c1f6d8a5f3a77c337189ba75  sides=["long","short"]
soak-ema3  ema_pullback:cf82c56b082da6e2995e1f63  sides=["long","short"]
soak-ema5  ema_pullback:7ece618beed71c6e3410fd48  sides=["long","short"]
soak-ema10 ema_pullback:8928d5841bee3fff536e7c59  sides=["long","short"]
soak-ema20 ema_pullback:191a4b2e10fd9196971a5004  sides=["long","short"]
soak-ema50 ema_pullback:b8ef3f2caf0ea4c80e268b18  sides=["long","short"]
eth-smoke  ema_pullback:243bcad65efa36d995d0830c  sides=["long","short"]
soak-ema5  ema_pullback:1a4edf9e70cbaa92620a6ff6  sides=["long"]
```

This means the intended six-instance LONG-only soak was not actually armed in Runtime. Continuing would have tested a mixed stale Runtime registration set rather than the prepared LONG-only catalog, so the soak was aborted before proceeding.

No new ABI correlation record was appended after the cleanup entries at `2026-08-21T18:09:12.976Z`. Fresh Runtime journal after start contains only the orchestration start above, without a corresponding completion or ABI write. No exchange mutation was performed by this aborted start beyond starting/stopping Runtime itself.

Result: `ABORTED_BEFORE_VALID_SOAK`. The next attempt needs Runtime durable registrations to be aligned with the LONG-only catalog instance IDs before Runtime is started again.
