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

