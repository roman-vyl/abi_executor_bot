## Context

Abi currently builds an execution plan containing a stop-market entry plus `stopLossAfterFill` and `takeProfitAfterFill` placeholders. Only the entry is mapped into `/v5/order/create`; protection is neither submitted nor verified. The existing demo flow can create, query by deterministic `orderLinkId`, amend, cancel, and confirm cleanup. The change spans domain modeling, Bybit mapping, create/update responses, tests, smoke tooling, and documentation.

bbb remains the source of absolute entry, stop-loss, and take-profit prices. Abi keeps fixed sizing (`0.001` by default), validates price ordering, and owns guarded execution and journaling. Mainnet live execution remains blocked.

Official Bybit V5 documentation confirms that [Create Order](https://bybit-exchange.github.io/docs/v5/order/create-order) accepts `takeProfit`, `stopLoss`, TP/SL trigger sources, `tpslMode`, and TP/SL order types, and that Full mode supports market TP/SL. [Amend Order](https://bybit-exchange.github.io/docs/v5/order/amend-order) accepts updated `takeProfit`, `stopLoss`, `tpTriggerBy`, `slTriggerBy`, and `tpslMode`; it does not require a separate position trading-stop call for this pending-entry amendment.

## Goals / Non-Goals

**Goals:**

- Attach full-position market TP/SL to each Bybit conditional entry create request using bbb prices.
- Make attached protection explicit in the execution plan, API previews, journaled Bybit request payloads, and update flow.
- Amend pending entry, TP, and SL values together through the existing intent update use case.
- Preserve existing response fields, order identity, create/query/amend/cancel behavior, dry-run semantics, failure states, and guards.
- Add focused unit coverage, documentation, future protection types, and a guarded smoke script without running it.

**Non-Goals:**

- Fill watching or fill-driven state transitions.
- Post-create verification that Bybit retained or activated protection.
- Repair through `/v5/position/trading-stop`.
- Emergency market close for missing, invalid, or breached protection.
- Partial-position or limit TP/SL.
- Position-sizing changes, mainnet enablement, or secrets/configuration changes.

## Decisions

### Add `attachedProtection` while retaining legacy plan fields

`ExecutionPlan` will gain an authoritative `attachedProtection` object with mode `full_position_market` and stop-loss/take-profit objects containing trigger price, trigger source, and `Market` order type. `buildExecutionPlan` will receive the configured trigger source as a narrow input rather than importing the full application config into the domain module.

The existing `stopLossAfterFill` and `takeProfitAfterFill` fields remain populated from the same intent during v1. This avoids breaking dry-run responses, journal readers, smoke output, and documentation consumers. The mapper will use `attachedProtection` for new Bybit fields; legacy fields are compatibility views, not a second source of truth.

Alternative considered: derive all protection only inside the mapper. Rejected because the execution plan and dry-run API would still misrepresent the intended atomic create operation.

### Use Bybit Full mode with market protection only

Create payloads will set `takeProfit`, `stopLoss`, `tpTriggerBy`, `slTriggerBy`, `tpslMode: "Full"`, `tpOrderType: "Market"`, and `slOrderType: "Market"`. Full-position market protection is the smallest operationally useful mode and avoids limit-price and partial-size semantics.

Alternative considered: use Partial mode to preserve future flexibility. Rejected because it introduces quantity and limit-price choices that are explicitly outside v1.

### Use the configured trigger source for entry and protection in v1

Entry, take-profit, and stop-loss will all use `config.bybitTriggerBy`, whose current default is `LastPrice`. Keeping one configured source preserves existing behavior and avoids adding configuration surface during the first attached-protection step. Documentation will state this default explicitly.

For later production hardening, entry, TP, and SL may need separate trigger-source settings; in particular, `MarkPrice` may be preferable for stop protection to reduce sensitivity to last-price wicks. That split requires an explicit contract and migration decision and is outside v1.

### Amend entry and attached protection through the existing update flow

`BybitAmendOrderPayload` will support optional `takeProfit`, `stopLoss`, `tpTriggerBy`, and `slTriggerBy`, and the mapper will populate them from the updated execution plan alongside the existing entry trigger fields. The initial order already establishes Full market mode, so v1 does not need to send `tpOrderType` or `slOrderType` on amend; those fields are not part of the official amend request contract. The mapper may include `tpslMode: "Full"` only if the implementation keeps the type aligned with the verified official amend contract.

The current service order remains: parse and validate the complete bbb payload, enforce immutable `instance_id`, build a new plan, map one amend request, call guarded execution, then journal updated intent/plan/status on success. This keeps the three updated prices coherent and preserves current failure behavior.

Alternative considered: call `/v5/position/trading-stop` after amendment. Rejected because the entry is still pending and v1 is specifically attached-entry protection; position repair belongs after verification detects a filled, unprotected position.

### Add `wouldAttachProtection` without renaming current response fields

POST and PUT success, dry-run, and Bybit failure response bodies will add `wouldAttachProtection: executionPlan.attachedProtection`. Existing fields such as `wouldCreateStopLossAfterFill`, `wouldUseStopLossAfterFill`, and their take-profit counterparts remain unchanged for compatibility. `wouldSendToBybit` continues to expose the exact mapped payload.

Alternative considered: rename the existing planned-after-fill fields. Rejected because it would create an unnecessary API break before consumers have migrated to the explicit field.

### Keep intent protection status semantics stable in v1

The existing intent status value `protection: "waiting_for_entry_fill"` remains unchanged. Attached TP/SL belongs to the pending order but only becomes position protection if the entry fills and Bybit activates it. Claiming `active` before verification would overstate safety. Future watcher work can introduce verified protection state transitions using the new types.

### Add future types with zero runtime wiring

`src/services/protection/protectionTypes.ts` will export `ProtectionState`, `ProtectionRepairAction`, and `ProtectionCheckResult`. The union values cover attached, active, missing, invalid, breached, set-trading-stop repair, and market-close repair. No route, service, adapter method, journal event, timer, or watcher will consume them in this change.

### Build a separate guarded smoke script

The attached-protection smoke will follow the established sandbox scripts: explicit `ABI_CONFIRM_TESTNET_WRITE=YES`, `/execution/mode` validation, unique timestamped identifiers, environment-supplied prices, temporary response files, expected-status checks, and best-effort cancellation on failure after confirmed creation. Because Bybit create/amend acknowledgement is asynchronous, order queries after those acknowledgements will use a bounded retry of at most five attempts with a 0.5-1 second delay. The existing amend smoke will use the same polling behavior.

The smoke will print protection values when Bybit returns them, but missing `takeProfit`, `stopLoss`, or `tpslMode` fields will not fail v1. Its success criteria are accepted create, successful order query, successful cancellation, and successful cleanup with no active entry order. It will be documented but not executed automatically.

## Risks / Trade-offs

- [Bybit accepts the create request but protection is absent or not activated after fill] → Document that v1 has no verification guarantee; keep the status at `waiting_for_entry_fill`; prioritize watcher/check/repair as the next change.
- [Bybit acknowledgement arrives before the order view is updated] → Poll the query briefly with a fixed attempt limit; do not use an unbounded wait.
- [Realtime order query omits attached TP/SL fields] → Treat those fields as informational smoke output, not v1 proof; defer authoritative verification to the watcher/check phase.
- [A fast fill occurs before the smoke script cancels] → Require distant operator-selected trigger prices, keep demo/testnet guard checks, and report final active orders; position cleanup remains a manual operator responsibility in this v1 script.
- [Create or amend payload semantics differ across Bybit account/category modes] → Keep scope to the existing linear demo/testnet configuration and cover exact mapper payloads with unit tests.
- [Legacy `AfterFill` names become misleading] → Mark `attachedProtection` as authoritative in docs and code usage while retaining legacy fields only for compatibility.
- [Amend updates one price but rejects another] → Send entry and protection in one verified V5 amend request; preserve the old plan and journal state if Bybit rejects it.
- [Responses and journal payloads grow] → Accept the small duplication during migration to avoid a breaking response change.

## Migration Plan

1. Add domain and mapper types, then update all execution-plan builder call sites and unit fixtures.
2. Add response previews and future-only protection types.
3. Update tests, docs, and the guarded smoke script.
4. Run `npm test` and `npm run build`; do not run the live smoke as part of implementation verification.
5. Deploy first to dry-run, inspect `wouldSendToBybit`, then perform a separately authorized demo smoke.

Rollback is a normal code revert: removing the new mapped fields returns Bybit create/amend behavior to entry-only operation. Because no persistent schema migration or new journal event type is introduced, existing journal records remain readable. Journaled execution plans containing `attachedProtection` must be tolerated as additive JSON by older readers.

## Open Questions

- Does Bybit's realtime order query consistently echo `takeProfit`, `stopLoss`, and `tpslMode` for conditional orders in the configured demo account mode? The smoke script will print these fields when present, but their absence will neither fail the smoke nor be treated as proof that protection is missing.
- Should the subsequent verification change inspect the conditional order first, the resulting position trading-stop state after fill, or both? That decision belongs to the fill watcher and repair design.
