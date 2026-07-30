# Legacy Signal/Intent Disposition

> Companion exploration artifact to `ENTRY_PACKAGE_EXECUTION_AUDIT.md`. Produced via
> `/opsx:explore`. This is a classification/disposition artifact, not an OpenSpec change
> — no production code, tests, or configuration were modified or deleted while producing
> it. Nothing here has been implemented.

## Purpose and how to read this file

A future `/opsx:propose abi-entry-package-execution-v1` takes **two** authoritative
inputs, each with a distinct, non-overlapping role:

```
ENTRY_PACKAGE_EXECUTION_AUDIT.md
→ authoritative architecture/execution input (what we build)

LEGACY_SIGNAL_INTENT_DISPOSITION.md
→ authoritative reuse/retirement input (what we reuse, what is forbidden
   to reuse, and what eventually gets deleted)
```

Every legacy signal/intent file or module gets exactly one status:

| Status | Meaning |
|---|---|
| `KEEP` | Not part of the legacy signal/intent contour being retired; stays indefinitely on its own merits, independent of Stage A. |
| `REUSE_AS_IS` | Entry-package execution calls this exact code unchanged. |
| `REUSE_WITH_ADAPTATION` | The mechanism/pattern is valuable, but needs modification (generalize labels, add new logic, or is reusable only for a later, not-yet-scoped capability) before entry-package can use it. |
| `LEGACY_ONLY` | Exists solely to keep the legacy `/signals` + `/intents/*` flow (and its smoke coverage) working. Entry-package **must not** depend on it. Not deletable yet. |
| `REMOVE_BEFORE_STAGE_A` | Unambiguously dead weight already — safe to delete now, in a separate cleanup pass, before `/opsx:propose`. |
| `REMOVE_AFTER_STAGE_A` | Will become dead weight once Stage A ships and the legacy flow + its smoke scripts are retired — not deletable yet, but the earliest realistic removal point is known. |

**Headline finding, before the per-file tables:** nothing in this repository currently
qualifies for `REMOVE_BEFORE_STAGE_A`. Every legacy file below is either actively wired
into `app/server.ts`'s route composition or actively imported by something that is, **and**
the entire legacy `/signals` + `/intents/*` surface is still exercised end-to-end by active
smoke scripts (`smoke:sandbox:contract`, `smoke:contract:fake`, `smoke:sandbox:amend`,
`smoke:sandbox:order`/`smoke:testnet:order`) that have no entry-package equivalent yet.
Deleting any of this now would silently regress verified coverage with nothing to replace
it. The earliest safe removal point for the legacy contour as a whole is
`REMOVE_AFTER_STAGE_A`, **conditional on** those smoke scripts being retired or migrated to
target entry-package first (see "Cleanup ordering" at the end).

### Precedence over `ENTRY_PACKAGE_EXECUTION_AUDIT.md` §16 on reuse mechanics

The main audit's Component Ownership diagram (§16) says the future
`EntryPackageApplicationService` "строит plan + Bybit payloads (переиспользует
`executionPlan.ts` / `bybitOrderMapper.ts`)". Read on its own, that phrase is ambiguous
about *how much* of each file is reused. This file is the authoritative source for that
precision — per this file's role above, on reuse/retirement questions it governs over the
main audit's shorthand, without requiring the main audit to be rewritten:

- **`executionPlan.ts` is not reused directly.** Per row §G above, only its conceptual
  *shape* (an `entryOrder` + `protection` structure) is a useful pattern — the
  `buildExecutionPlan` function and `ExecutionPlan`/`Protection` types are not callable,
  because they're built against the legacy `SignalIntent` type and hardcode the broken
  legacy `buildOrderLinkId(instanceId, "entry")` derivation. The future entry-package plan
  builder is new code that happens to produce a similarly-shaped plan, not a call into
  this file.
- **`bybitOrderMapper.ts` is reused at the level of individual mapping logic, not the
  legacy `mapExecutionPlanToBybit(config, ExecutionPlan)` function.** Per row §G above,
  `mapTriggerDirection` is reused directly by the new `EntryOrderSemanticsMapper` chain,
  and `mapSide`/`tpslMode`-wiring logic is a reusable pattern — but the function itself
  takes the legacy `ExecutionPlan` type as input and is not callable as-is.

No further main-audit rewrite is needed for this — this section is the resolution.

---

## A. Transport / route layer (signal & intent specific)

| File / module | Responsibility | Called by | Smoke/tests need it? | May entry-package depend on it? | Status |
|---|---|---|---|---|---|
| `src/routes/signalRoutes.ts` | `POST /signals` route: parses body, delegates to `createSignalIntent`. | `app/server.ts` | Yes — `smoke:sandbox:contract`, `smoke:contract:fake`, `smoke:sandbox:order` all POST `/signals`. | No — entirely separate transport (`entryPackageRoutes.ts` is its own boundary). | `LEGACY_ONLY` |
| `src/routes/intentRoutes.ts` | `PUT/POST-cancel/GET /intents/*` routing (amend, cancel, status, order lookup). | `app/server.ts` | Yes — heavily exercised by `smoke:sandbox:contract`, `smoke:sandbox:amend`. | No. | `LEGACY_ONLY` |
| `src/services/intentService.ts` | Barrel re-export of `intents/*` functions. | `intentRoutes.ts`, `test/unit/intentService.test.ts` | Indirectly yes. | No. | `LEGACY_ONLY` |

## B. Domain / validation (signal & intent specific)

| File / module | Responsibility | Called by | Smoke/tests need it? | May entry-package depend on it? | Status |
|---|---|---|---|---|---|
| `src/domain/signals.ts` (`parseSignalIntent`) | Legacy request DTO parsing: `Number()`-based positive-price checks, symbol allowlist check, entry/stop/take shape validation. | `createSignalIntent.ts`, `updateIntent.ts` | Yes, indirectly via `/signals`, `/intents/:id`. | No — fully superseded by `entryPackageApi.ts`'s stricter exact-decimal validation (main audit §4); reusing `Number()`-based parsing would be a regression, not a shortcut. | `LEGACY_ONLY` |
| `src/domain/intents.ts` (`IntentStatus`, `createPlannedIntentStatus`, `createCancelledIntentStatus`, `createFailedToCreateEntryIntentStatus`) | Legacy status machine keyed by `intentId = signalId`. | `createSignalIntent.ts`, `updateIntent.ts`, `cancelIntent.ts` | Yes, indirectly. | No — the literal type doesn't map 1:1 onto entry-package's `pending_create/applied/pending_replace/pending_cancel/absent/create_failed/unknown/terminal_unfilled` states (see `ENTRY_PACKAGE_EXECUTION_AUDIT.md` §8). | `LEGACY_ONLY` |

## C. Service orchestration (signal & intent specific)

| File / module | Responsibility | Called by | Smoke/tests need it? | May entry-package depend on it? | Status |
|---|---|---|---|---|---|
| `src/services/signals/createSignalIntent.ts` | Full create orchestration: validate → risk → dedupe (`hasSignal`/`findActiveIntentByInstanceId`) → plan → pre-snapshot → guarded execute → verify → journal → respond. | `signalRoutes.ts` | Yes, heavily. | Only as a **conceptual template** for `EntryPackageApplicationService`'s orchestration shape (main audit §4/§16) — the code itself must not be called; its dedupe/active-intent rules are ABI-invented business logic the canonical entry-package spec forbids reintroducing. | `LEGACY_ONLY` |
| `src/services/signals/createSignalIntentTypes.ts` | Types for the above. | `createSignalIntent.ts` | Same as above. | No. | `LEGACY_ONLY` |
| `src/services/intents/updateIntent.ts` | Amend orchestration; signal-keyed journal lookups, re-derives execution plan. | `intentRoutes.ts` | Yes. | No. | `LEGACY_ONLY` |
| `src/services/intents/cancelIntent.ts` | Cancel orchestration; loads latest plan from journal, calls `cancelEntryOrder`. | `intentRoutes.ts` | Yes. | No. | `LEGACY_ONLY` |
| `src/services/intents/queryIntent.ts` (`getEntryOrder`, `getIntentStatus`) | Signal-keyed read path: order lookup by stored `orderLinkId`, status read from journal. | `intentRoutes.ts` | Yes — `smoke:sandbox:contract` reads order status via this path. | No. | `LEGACY_ONLY` |
| `src/services/intents/common.ts` (`badSignalId`, `IntentServiceInput`, `ServiceResponse`) | Tiny shared helper/types for the `intents/*` family only. | `updateIntent.ts`, `cancelIntent.ts`, `queryIntent.ts` | Indirectly yes. | No. | `LEGACY_ONLY` |

## D. Risk / sizing (signal-coupled; one item has a documented hard-NO)

| File / module | Responsibility | Called by | Smoke/tests need it? | May entry-package depend on it? | Status |
|---|---|---|---|---|---|
| `src/risk/riskGuard.ts` (`checkSignalRisk`) | Validates `fixedSmokeQty` positivity **and** stop/take price ordering via `Number()`. | `createSignalIntent.ts`, `updateIntent.ts` | Yes — the "take-profit without stop-loss is rejected" negative-path smoke case depends on this. | **Explicit hard NO**, already documented in `ENTRY_PACKAGE_EXECUTION_AUDIT.md` §4 as a *negative-reuse* finding: the canonical entry-package spec forbids ABI adding a price-order rule to `DesiredEntry`. Reusing this function would violate the shipped public contract, not just be redundant. | `LEGACY_ONLY` |
| `src/risk/positionSizing.ts` (`calculatePositionSize`) | Returns `config.fixedSmokeQty` literally; `void intent`. | `createSignalIntent.ts`, `updateIntent.ts` | Yes — embedded in every dry-run response. | No — superseded by `PositionSizeCalculator`/`FixedMinimumPositionSizeCalculator` (audit §6), which honestly accounts for `min_order_qty`/`qty_step`/`min_notional_value`. Reusing the literal-return function would reintroduce the exact dishonesty the audit already fixed. | `LEGACY_ONLY` |

## E. Order identity

| File / module | Responsibility | Called by | Smoke/tests need it? | May entry-package depend on it? | Status |
|---|---|---|---|---|---|
| `src/domain/orderIdentity.ts` (`buildOrderLinkId(instanceId, kind)`) | Deterministic `orderLinkId` hash keyed **only** on `instanceId`. | `executionPlan.ts` (`buildExecutionPlan`) | Yes — embedded `orderLinkId` in every legacy dry-run/live response and used by every smoke script's order lookups. | **No — proven broken for entry-package** (audit §7): collides across sequential `trade_cycle_id`s of the same `strategy_instance_id`. Entry-package needs a new sibling derivation, `hash(strategy_instance_id, trade_cycle_id, role, generation)`, which does not exist yet and is not this file's concern to design (that's the audit's job). | `LEGACY_ONLY` |

## F. Journal

| File / module | Responsibility | Called by | Smoke/tests need it? | May entry-package depend on it? | Status |
|---|---|---|---|---|---|
| `src/journal/journal.ts` (`Journal` class) | **Mixed.** Low-level append-only JSONL I/O (`appendEvent`, `readEvents` replay-with-skip-bad-lines) is generic. Public query surface (`hasSignal`, `findLastEvent`, `findActiveIntentByInstanceId`) is signal-shaped business logic. | `createSignalIntent.ts`, `updateIntent.ts`, `cancelIntent.ts`, `queryIntent.ts`, `verifyPostCreateProtection.ts`, `app/server.ts` (instantiation) | Yes — the audit trail for the entire legacy flow. | **Partial.** The low-level append/replay *pattern* is explicitly the model for the new `CorrelationRepository` (audit §11) — extract a shared I/O helper, not the class. The class's public query API (`hasSignal`/`findActiveIntentByInstanceId`) must **not** be reused: it bakes in the ABI-invented "one active planned intent per instance" rule, which the canonical spec forbids reintroducing for entry-package. | `REUSE_WITH_ADAPTATION` |
| `src/journal/journalPayloads.ts` (`isCancelledStatus`, `isExecutionPlan`, `readPayloadString`) | Legacy payload-shape type guards for `ExecutionPlan`/`CancelledStatus` objects stored inside `Journal` events. | `cancelIntent.ts`, `updateIntent.ts` | Yes, indirectly. | No — entry-package's correlation record (`EntryPackageExecutionRecord`, audit §8) is a structurally different schema; these guards don't apply to it. | `LEGACY_ONLY` |

## G. Exchange mechanics (generic — never signal-specific)

| File / module | Responsibility | Called by | Smoke/tests need it? | May entry-package depend on it? | Status |
|---|---|---|---|---|---|
| `src/exchange/bybitAdapter.ts` (`RestBybitAdapter`, `StubBybitAdapter`, `BybitAdapter` interface) | Pure Bybit REST client — no signal/instance concept anywhere in its types or implementation. | Everything: signals, intents, account routes, protection, and the future entry-package `ExchangeGateway`. | Yes, universally. | **Yes — already the designated `ExchangeGateway`** (audit §16), but not unmodified: Stage A adds `InstrumentTradingRulesProvider` (audit §6), which needs a new `GET /v5/market/instruments-info` method on this adapter/interface — existing methods (`createOrder`, `amendOrder`, `getOrderByLinkId`, etc.) are called as-is, but the module/interface as a whole gains a new member. | `REUSE_WITH_ADAPTATION` |
| `src/exchange/bybitOrderMapper.ts` (`mapExecutionPlanToBybit`, `mapSide`, `mapPositionSideToCloseSide`, `mapTriggerDirection`) | Bybit payload mapping. | `createSignalIntent.ts`/`updateIntent.ts`/`cancelIntent.ts`/`queryIntent.ts` (via `mapExecutionPlanToBybit`), `accountActions.ts` and `verifyPostCreateProtection.ts` (via `mapPositionSideToCloseSide`). | Yes. | **Partial.** `mapTriggerDirection` (`rises_to/falls_to → 1/2`) is exactly the last-mile encoding the new `EntryOrderSemanticsMapper` chain reuses (audit §16). `mapPositionSideToCloseSide` is generic and reusable as-is (relevant to a later, not-yet-scoped fill/close capability, not Stage A). `mapExecutionPlanToBybit(config, plan: ExecutionPlan)` itself takes the **legacy** `ExecutionPlan` type and is not directly callable — entry-package needs its own payload builder that reuses the individual field-mapping *logic* (tpslMode, trigger-by wiring), not this function's signature. | `REUSE_WITH_ADAPTATION` |
| `src/execution/execution.ts` (`executeEntryOrder`, `amendEntryOrder`, `cancelEntryOrder`, `executeMarketCloseOrder`) | Guarded wrappers around Bybit create/amend/cancel; takes only `config`/`bybit`/`payload`. | `createSignalIntent.ts`, `updateIntent.ts`, `cancelIntent.ts`, `verifyPostCreateProtection.ts` | Yes. | **Yes — already the designated `ExchangeGateway`'s command layer** (audit §16). | `REUSE_AS_IS` |
| `src/execution/liveGuard.ts` (`getLiveExecutionMode`) | Pure config-based dry-run/live gating. | `execution.ts`, `accountRoutes.ts`, `systemRoutes.ts` | Yes. | Yes. | `REUSE_AS_IS` |
| `src/domain/executionPlan.ts` (`buildExecutionPlan`, `ExecutionPlan`, `Protection` types) | Builds the legacy `ExecutionPlan` from the legacy `SignalIntent` + `PositionSize`; calls `buildOrderLinkId(intent.instanceId, "entry")` directly inside. | `createSignalIntent.ts`, `updateIntent.ts`, (read back by `cancelIntent.ts`/`queryIntent.ts`) | Yes. | No, as written — input type is the legacy `SignalIntent`, and it hardcodes the broken legacy identity derivation (§E above). The `entryOrder` + `protection` **shape** is a useful conceptual pattern for entry-package's own new plan builder, but the function/type itself is not callable. | `LEGACY_ONLY` |

## H. Protection / confirmation

| File / module | Responsibility | Called by | Smoke/tests need it? | May entry-package depend on it? | Status |
|---|---|---|---|---|---|
| `src/services/protection/protectionDecision.ts` (`decideProtectionCheck`, `isOpenPosition`) | Pure decision function: stop-breach math, position-snapshot classification. No journal/signal I/O; context fields are opaque labels. | `verifyPostCreateProtection.ts` | Yes, indirectly. | **Not for Stage A** — this is post-fill protection/emergency-close logic, explicitly out of Stage A scope (audit §10/§17/§26: Stage A does field-accuracy confirmation of a *pending* order, not post-fill position management). Genuinely reusable code, just for a later, not-yet-scoped capability. | `REUSE_WITH_ADAPTATION` |
| `src/services/protection/protectionTypes.ts` | Supporting types for the above (`ProtectionCheckContext` carries `signalId`/`instanceId` as labels). | `protectionDecision.ts`, `verifyPostCreateProtection.ts` | Same. | Same as above; labels would need generalizing to `strategy_instance_id`/`trade_cycle_id` if/when reused. | `REUSE_WITH_ADAPTATION` |
| `src/services/protection/verifyPostCreateProtection.ts` (`capturePreCreateProtectionSnapshot`, `verifyPostCreateProtection`, `appendProtectionCompletion`, etc.) | Bounded-retry query mechanics (2×300ms: `getOrderByLinkId` + `getPosition`), currently scoped to post-fill emergency-close decisions. | `createSignalIntent.ts` | Yes. | **Yes, directly** — the single clearest reuse case in this whole file. Explicitly named in `ENTRY_PACKAGE_EXECUTION_AUDIT.md` §10/§16 as what `PackageConfirmationComponent` extends. Needs: (a) new field-accuracy diffing logic (compare returned order fields to desired, not just presence/absence), (b) journal coupling replaced with `CorrelationRepository`, (c) fill-before-ack classification per audit §26. | `REUSE_WITH_ADAPTATION` |

## I. Config / bootstrap (generic; one field is legacy-coupled)

| File / module | Responsibility | Called by | Smoke/tests need it? | May entry-package depend on it? | Status |
|---|---|---|---|---|---|
| `src/config/config.ts` (`AbiConfig`, `loadConfig`) | Generic env-driven config loader. Contains one legacy-specific field, `fixedSmokeQty`/`ABI_FIXED_SMOKE_QTY`. | Everything | Yes. | **Yes for the file/type as a whole** (bybit\*, dryRun, liveTradingEnabled, journalPath, etc. are all still needed). **No for the `fixedSmokeQty` field specifically** — superseded by `InstrumentTradingRulesProvider`-based sizing (audit §6). | `REUSE_WITH_ADAPTATION` (file); the `fixedSmokeQty` field itself is `REMOVE_AFTER_STAGE_A`, once `positionSizing.ts`/`riskGuard.ts` retire. |
| `src/app/server.ts` | Wires all routes together (system, account, entry-package, signal, intent); instantiates `Journal`. | Process entrypoint | Yes. | N/A — this file itself isn't a reuse candidate, it's the composition root that will be edited (not by this disposition) to add entry-package wiring now and remove legacy route wiring later. | `KEEP` |
| `src/app/index.ts` | Startup logging; references `config.fixedSmokeQty` for informational output only. | Process entrypoint | Yes (cosmetic). | N/A. Trivial log-line coupling to the legacy field, prunable in the same later pass as `config.ts`'s `fixedSmokeQty`. | `KEEP` |
| `src/app/http.ts` (`readJsonBody`, `writeJson`, `getPathname`) | Fully generic HTTP helpers. | Every route, including `entryPackageRoutes.ts` today. | Yes. | Yes — already used by the entry-package route. | `REUSE_AS_IS` |

## J. Account / operator surface — not part of the legacy signal/intent contour

These are included for completeness because they live alongside the legacy files, but they
are **independent** of `/signals`/`/intents/*` and are not being retired by Stage A.

| File / module | Responsibility | Called by | Smoke/tests need it? | May entry-package depend on it? | Status |
|---|---|---|---|---|---|
| `src/account/accountActions.ts` | Balance/active-orders/positions query builders, cancel-all/close-all payload builders. No signal/journal coupling anywhere. | `accountRoutes.ts` | Yes (`smoke:sandbox:read` and others). | Not needed by Stage A, but nothing prevents it. | `KEEP` |
| `src/routes/accountRoutes.ts` | `/account/*` operator endpoints. | `app/server.ts` | Yes. | N/A. | `KEEP` |
| `src/routes/systemRoutes.ts` | `/health`, `/execution/mode`. `/health` output includes `config.fixedSmokeQty` (cosmetic legacy coupling only). | `app/server.ts` | Yes. | N/A. `fixedSmokeQty` in the `/health` payload can be pruned alongside `config.ts` cleanup, non-urgent. | `KEEP` |

## K. Tests

| File / module | Covers | Smoke/tests need it? | May entry-package depend on it? | Status |
|---|---|---|---|---|
| `test/unit/createSignalIntent.test.ts` | Legacy create orchestration. | It *is* the test. | No. | `LEGACY_ONLY` |
| `test/unit/signalRoutes.test.ts` | `POST /signals` routing. | It *is* the test. | No. | `LEGACY_ONLY` |
| `test/unit/signals.test.ts` | `parseSignalIntent`. | It *is* the test. | No. | `LEGACY_ONLY` |
| `test/unit/intentService.test.ts` | `intents/*` orchestration. | It *is* the test. | No. | `LEGACY_ONLY` |
| `test/unit/riskGuard.test.ts` | `checkSignalRisk` (the forbidden-for-entry-package price-ordering rule). | It *is* the test. | No. | `LEGACY_ONLY` |
| `test/unit/protectionDecision.test.ts` | `decideProtectionCheck`. | It *is* the test. | Not for Stage A; useful spec template for a later protection-check capability. | `REUSE_WITH_ADAPTATION` |
| `test/unit/protectionService.test.ts` | `verifyPostCreateProtection` orchestration (incl. journal `signalId` coupling). | It *is* the test. | Closest existing test template for the future `PackageConfirmationComponent` tests. | `REUSE_WITH_ADAPTATION` |
| `test/unit/bybitOrderMapper.test.ts` | Exchange-mechanics mapping, largely generic. | It *is* the test. | Yes — extend alongside new `EntryOrderSemanticsMapper`/Bybit-numeric-encoding tests, don't replace. | `REUSE_WITH_ADAPTATION` |
| `test/unit/accountActions.test.ts` | Account/operator surface. | It *is* the test. | N/A, unrelated. | `KEEP` |
| `test/unit/config.test.ts` | `loadConfig`. | It *is* the test. | N/A; will gain new assertions for new config fields over time, not a disposition concern. | `KEEP` |
| `test/fakes/fakeBybitAdapter.ts` | Shared `BybitAdapter` test double. | Used by nearly every test file. | Yes — but must track `bybitAdapter.ts`'s interface change above: needs a new fake method for `instruments-info`, mirroring the adapter's new member. Its overall pattern is still explicitly the model for the future `FakeInstrumentTradingRulesProvider` (audit §6/§11). | `REUSE_WITH_ADAPTATION` |
| `test/fixtures/config.ts` | Shared `AbiConfig` fixture builder. | Used broadly. | Yes — will gain new fields for entry-package config additions in the same file (not unmodified). | `REUSE_WITH_ADAPTATION` |
| `test/unit/entryPackageApi.test.ts`, `test/unit/entryPackageOpenApi.test.ts`, `test/unit/entryPackageRoutes.test.ts` | Entry-package transport contract (already shipped, `abi-entry-package-api-v1`). | It *is* the test. | N/A — not legacy, already entry-package's own. | `KEEP` |

## Docs and smoke scripts

| File | Role | Status | Note |
|---|---|---|---|
| `docs/BBB_CONTRACT.md` | Documents the legacy `/signals` contract exclusively. | `LEGACY_ONLY` | Retire/archive alongside the code, not before it — docs should reflect reality, not precede it. |
| `TESTNET_SMOKE.md` | Documents the legacy smoke scripts below. | `LEGACY_ONLY` (for the sections describing `/signals`/`/intents` smoke) | Same ordering caveat. |
| `README.md` | Mixed — "Current signal contract" / dry-run example sections are legacy; account-balance and Docker sections are not. | Not a single-file disposition candidate. | Prune the legacy sections in the same pass that retires the code; the account/Docker sections stay (`KEEP`). |
| `scripts/smoke-sandbox-contract-matrix.sh` (`npm run smoke:sandbox:contract`) | Exercises `/signals` create + `/intents/*` amend/cancel/query end-to-end, including the invalid-take-profit-only negative case. | `LEGACY_ONLY` | **Do not remove the legacy code until this script is retired or migrated to target entry-package.** This is the single most important ordering constraint in this file. |
| `scripts/smoke-contract-matrix-fake.sh` + `scripts/fake-abi-smoke-server.mjs` (`npm run smoke:contract:fake`) | Fake-server-backed version of the same matrix. | `LEGACY_ONLY` | Same condition. |
| `scripts/smoke-sandbox-amend.sh` (`npm run smoke:sandbox:amend`) | Exercises `PUT /intents/:signalId` amend flow specifically. | `LEGACY_ONLY` | Same condition. |
| `scripts/smoke-testnet-order.sh` (`npm run smoke:sandbox:order` / `smoke:testnet:order`) | Exercises `POST /signals` create + cancel against real testnet/demo. | `LEGACY_ONLY` | Same condition. |
| `scripts/smoke-testnet-readonly.sh` (`npm run smoke:sandbox:read` / `smoke:testnet:read`) | Balance/active-orders/positions only — does **not** touch `/signals` or `/intents/*`. | `KEEP` | Independent of legacy retirement. |

---

## Cleanup ordering

No file in this repository is `REMOVE_BEFORE_STAGE_A` today. The dependency chain that
blocks earlier removal is exactly:

```
legacy code (A–F above)
  ⟵ still imported/routed by app/server.ts
  ⟵ still exercised by smoke:sandbox:contract, smoke:contract:fake,
     smoke:sandbox:amend, smoke:sandbox:order/smoke:testnet:order
  ⟵ those scripts have no entry-package equivalent yet
```

Recommended order for a **later** cleanup pass (not now, not part of this disposition):

1. Ship `abi-entry-package-execution-v1` (Stage A).
2. Build entry-package-targeted smoke coverage equivalent to what the legacy scripts
   verify today (create/replace/cancel/confirm matrix, invalid-input negative cases).
3. Retire or repoint the legacy smoke scripts (`smoke-sandbox-contract-matrix.sh`,
   `smoke-contract-matrix-fake.sh`, `smoke-sandbox-amend.sh`, `smoke-testnet-order.sh`)
   and the fake smoke server.
4. Only then remove the `LEGACY_ONLY` code in sections A–F, the legacy-only tests in K,
   and the `fixedSmokeQty` field from `config.ts`/`app/index.ts`/`systemRoutes.ts`.
5. Prune the legacy sections of `README.md`, and archive `docs/BBB_CONTRACT.md` /
   `TESTNET_SMOKE.md`'s legacy portions.

This file does not perform any of the above — it only classifies. No code, test, doc, or
script was modified or deleted while producing it.
