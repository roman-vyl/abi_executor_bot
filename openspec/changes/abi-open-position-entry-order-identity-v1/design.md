## Context

Facts from ABI main `35b4436`:

- **Fill query identity.** The record's `order_link_id` is the deterministic identity of this cycle's current entry order (`domain/entryPackageOrderIdentity.ts:8-20`). Every fill check queries Bybit by exactly this value:
  - the order realtime/history read uses it with `limit=1`;
  - the decoder rejects a row whose `orderLinkId`, symbol or `positionIdx` differs (`orderQueryResponseDecoder.ts:96-107`);
  - `first_fill_at_ms` is the minimum `execTime` of `/v5/execution/list` filtered by it.
- **orderId in the decoder.** The decoded order row carries `orderId`, or `""` when Bybit gives none (`orderQueryResponseDecoder.ts:148`).
- **Lookup paths.** `resolveOwnFillFacts` (`openPositionResolutionService.ts:285-336`) has two:
  - **reuse:** when the stored `early_execution_observation` is final, the observation is reused and the order is not read. The observation has no order id.
  - **fresh:** otherwise one `confirmEntryPackage` read runs, and its `confirmation.order` row carries `orderId`.
- **When the observation is stored.** Only by the apply-time confirmation (`entryPackageApplicationService.ts:723, 777`), from `confirmation.observation` of the same read whose `confirmation.order` the applied response already uses for `order_link_id`/`order_id` (`abi-apply-entry-order-identity-v1`).
- **Recovery path.** The recovery-state resolution reads the same row through `classifyEntryOrderForRecovery`. The `RecoveryEntryOrderSignal` does not carry `orderId`; this is marked as deferred in `recoveryConvergencePolicy.ts:59-62`.
- **Order id from create.** The record's `order_id` comes from the create acknowledgement (`readBybitOrderId`), not from a row that proved a fill.

## Decisions

### D1. Two keys, always present, null when not open

`entry_order_link_id` and `entry_order_id` are added to the open-position success body as required keys, each a non-empty string or `null`.

- When `position_open` is `false`, closure or not, both are `null`.
- When `position_open` is `true`, `entry_order_link_id` is non-null and `entry_order_id` is a string or `null`.
- The body stays a closed object.

### D2. entry_order_link_id is the proof's own query key

`entry_order_link_id` is the `order_link_id` of the current binding that the fill proof just used: the order read (fresh path), or the apply-time read the observation came from (reuse path), plus the `first_fill_at_ms` execution query.

- It is never taken from `binding_history`.
- An open result without a non-null `order_link_id` is already impossible (`first_fill_at_ms` capture requires it). If it happens, it stays `internal_error`.

### D3. entry_order_id only from a row matched by that orderLinkId

| Path | Source of `entry_order_id` |
|---|---|
| Fresh read | `confirmation.order.orderId` of the read that produced `position_open: true` |
| Reuse of a stored final observation with `order_id` | that stored `order_id` |
| Reuse of a stored observation whose `order_id` is `null` or absent | `null` |
| Recovery `position_open` | `orderId` of the row behind the `live_with_fill` / `terminal_with_fill` signal |

- An empty `orderId` from the decoder is reported as `null`.
- The create-acknowledgement `order_id` of the record is never used, even when non-null, because it did not come from a row that proved the fill.
- No path adds a Bybit request.

### D4. Observation carries the order id it was read with

`EarlyExecutionObservation` gains optional `order_id: string | null`.

- **Writers:** the two apply-time writers set it from `confirmation.order.orderId` (`""` → `null`) in the same save as today. No other writer changes.
- **Readers:** the record validator accepts an observation without the key and reads it as `null`.
  - This is not legacy support. The correlation file is replayed at startup, and a record that fails the schema fails readiness (`entryPackageCorrelationRepository.ts:93-98`), so a required key would stop ABI on the existing file.
  - Nothing is migrated or rewritten.
- **Decisions:** nothing that decides open, closed, terminal or close quantity reads it.

### D5. Recovery signal carries the row's orderId

`RecoveryEntryOrderSignal`'s `live_with_fill` and `terminal_with_fill` variants gain `orderId: string | null` from the decoded row they are built from.

- **Response:** the recovery-state success body gets the same two keys. They are non-null only for `position_open`, with D2 and D3 sourcing, and `null` for every other state.
- **Unchanged:** recovery classification, convergence and the existing deferred `convergeToApplied` rule on `order_id` do not change. Convergence does not write the new `orderId` into the record.

### D6. Unchanged

- **Determination:**
  - open/closed determination and the partial-fill rule (any own fill counts as open);
  - `average_entry_price` (current cumulative average);
  - the `first_fill_at_ms` capture and its single durable write;
  - the closure proof and the error envelope.
- **Record and state:** correlation record status and every other record field.
- **Callers:** the apply response.

## Risks / Trade-offs

- **Runtime strict codecs.** A Runtime that does not know the keys rejects the body, so the Runtime update and the ABI change are rolled out together: Runtime merges first, then both are deployed in one step.
- **Missing order id.** `entry_order_id` is `null` whenever the proving row had no `orderId`, and for cycles whose entry filled at apply time before this change, for their whole life. No backward compatibility or migration is provided beyond loading the record. Runtime and Journal must treat `null` as "not known", never as "no order".
- **Partial fills.** On a partially filled live order `position_open` is already `true`. The identifiers name that same order, so later fills of the same order share them. Different prices, quantities and timestamps per fill are not part of this contract; they belong to the future ABI physical journal (journal_service #7).
- **Spec layering.** The open-position body is a MODIFIED requirement written on top of `abi-trade-cycle-closure-confirmation-v1`. The recovery body is an ADDED requirement, because `abi-entry-order-not-found-recovery-v1` renames the base requirement. When archiving, after both of those, the two keys are folded into the five-state requirement's field list.
