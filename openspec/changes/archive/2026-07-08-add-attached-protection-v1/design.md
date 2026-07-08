## Context

Abi accepts a bbb signal, builds an execution plan, maps it to Bybit, and journals the intent lifecycle. The current execution plan contains `stopLossAfterFill` and `takeProfitAfterFill`, but those fields describe a future workflow that is no longer desired. Bybit V5 can attach full-position market stop-loss and take-profit directly to a conditional entry create request.

Abi is new, so there is no persisted API or journal compatibility requirement for the temporary planned-after-fill model. bbb owns absolute entry, stop-loss, and take-profit prices. Abi keeps fixed sizing, validates the supplied shape and price ordering, generates the entry `orderLinkId`, and guards execution. Mainnet remains blocked.

## Goals / Non-Goals

**Goals:**

- Support entry-only, entry-plus-stop, and entry-plus-stop-plus-take-profit bbb signals.
- Use one authoritative `ExecutionPlan.protection` model with no planned-after-fill representation.
- Map optional protection fields correctly into Bybit create and pending-entry amend payloads.
- Keep `PUT /intents/:signalId` able to update entry and desired protection together on the existing entry `orderLinkId`.
- Make dry-run, live, failure, and journal previews reflect the same single protection model.
- Preserve fixed sizing, order identity, guards, and existing intent flows.

**Non-Goals:**

- Post-create query/retry or verification that Bybit retained protection.
- Fill watching or fill-driven protection state.
- Repair through `/v5/position/trading-stop`.
- Emergency close when protection is missing, invalid, or breached.
- Partial-position or limit TP/SL.
- Position-sizing changes, mainnet enablement, or secrets/configuration changes.

## Decisions

### Accept exactly three protection shapes

`stop_loss` and `take_profit` become optional at the signal parser boundary, with these valid combinations:

1. neither field: entry only;
2. `stop_loss` only: attached stop loss;
3. `stop_loss` and `take_profit`: attached stop loss and take profit.

`take_profit` without `stop_loss` is rejected in v1. Risk validation remains shape-aware: entry-only has no protection ordering check; stop-only requires the stop on the protective side of entry; stop-plus-take requires the existing complete long or short ordering.

Alternative considered: accept any independent combination. Rejected because the requested v1 contract deliberately does not support take-profit-only positions.

### Make `ExecutionPlan.protection` the only source of truth

The execution plan will contain `entryOrder` and a `protection` discriminated union:

```ts
type Protection =
  | { mode: "none" }
  | {
      mode: "attached_full_position_market";
      stopLoss?: { triggerPrice: string; triggerBy: string; orderType: "Market" };
      takeProfit?: { triggerPrice: string; triggerBy: string; orderType: "Market" };
    };
```

The attached variant must contain at least one protection leg. `stopLossAfterFill` and `takeProfitAfterFill` are removed, and no second protection representation is retained. The mapper, API previews, tests, and journaled execution plans read only `protection`.

Alternative considered: retain old fields as aliases. Rejected because aliases create two representations that can disagree and there is no legacy consumer to protect.

### Map create fields conditionally

For `protection.mode === "none"`, `createEntryOrder` contains no `stopLoss`, `takeProfit`, TP/SL trigger source, mode, or TP/SL order-type fields.

For attached protection, the mapper adds `tpslMode: "Full"` and only the fields required by present legs:

- stop loss: `stopLoss`, `slTriggerBy`, `slOrderType: "Market"`;
- take profit: `takeProfit`, `tpTriggerBy`, `tpOrderType: "Market"`.

Entry and both protection legs use `config.bybitTriggerBy`, currently defaulting to `LastPrice`. Separate trigger-source configuration remains future work.

### Treat PUT as the desired complete pending-intent representation

`PUT /intents/:signalId` continues to parse and validate a complete signal body, preserve `instance_id`, rebuild the execution plan, and target the existing entry `orderLinkId`. The amend payload includes the updated entry trigger and every present protection leg with its trigger source.

When the new desired plan removes a previously attached leg, the implementation must explicitly clear that Bybit leg using the V5 amend removal value rather than omitting the field and accidentally retaining stale protection. Entry-only amendment therefore clears both legs; stop-only amendment clears take profit. This keeps Bybit state aligned with the single execution-plan source of truth.

Alternative considered: treat omitted protection as "leave unchanged." Rejected because that conflicts with PUT replacement semantics and can make the journaled plan disagree with Bybit.

### Expose one response model

POST and PUT dry-run, live success, and Bybit failure responses expose the execution plan's `protection` in one explicit preview field, such as `wouldUseProtection`. Existing entry and exact `wouldSendToBybit` payload previews remain. No `wouldCreateStopLossAfterFill`, `wouldCreateTakeProfitAfterFill`, `wouldUseStopLossAfterFill`, or `wouldUseTakeProfitAfterFill` fields are produced.

### Keep verification and repair in a separate change

This change ends when Abi can express, create, and amend the desired optional attached protection. A subsequent `protection-verification-and-repair-v1` change will design:

- bounded query/retry after asynchronous create/amend acknowledgement;
- verification of pending order protection;
- after-fill watcher and position protection verification;
- repair of missing protection through `/v5/position/trading-stop`;
- emergency market close when a position exists and current price has already breached the intended stop.

Keeping this separate prevents create mapping from being coupled prematurely to monitoring, recovery, and emergency policy.

## Risks / Trade-offs

- [Bybit accepts create/amend asynchronously] → Do not claim verification in this change; handle acknowledgement polling in `protection-verification-and-repair-v1`.
- [Omitted amend fields leave stale Bybit protection] → Use explicit removal values when the PUT desired state removes a leg.
- [Optional protection weakens current price assumptions] → Add shape-specific parser and risk tests for all three valid forms and reject take-profit-only input.
- [A position can still become unprotected after acceptance] → Document the limitation and prioritize the separate verification/repair change.
- [Removing temporary fields changes responses and journals] → Accept the clean break because the project is new and has no legacy compatibility requirement.

## Migration Plan

1. Make signal protection fields optional and add shape-aware validation.
2. Replace the execution-plan planned-after-fill fields with the `protection` union and update all builders/readers.
3. Map conditional create and complete desired-state amend payloads.
4. Replace response previews and update tests and documentation.
5. Run `npm test` and `npm run build`; do not run live smoke without separate authorization.

No persistent migration or compatibility layer is required. Rollback is a normal code revert before production adoption.

## Open Questions

- Should separate entry, stop-loss, and take-profit trigger sources be introduced after v1, with `MarkPrice` considered for stop protection?
- What exact verification and emergency-close policy should `protection-verification-and-repair-v1` use after a fill or a breached stop?
