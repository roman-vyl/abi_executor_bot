## Context

The recovery resolver already performs three attempts separated by 300 ms. Each attempt
classifies the exact `order_link_id` through realtime then order history. Its internal
union contains `not_found`, but today a request whose attempts stay absent ends as
`internal_error`.

Two official Bybit constraints shape the safe boundary:

- official [Get Order History](https://bybit-exchange.github.io/docs/v5/order/order-list)
  and [Get Trade History](https://bybit-exchange.github.io/docs/v5/order/execution)
  contracts return the most recent seven days when `startTime`/`endTime` are omitted, as
  the current adapter does;
- the official [Demo Trading Service](https://bybit-exchange.github.io/docs/v5/demo)
  contract states that generated Demo orders are kept for seven days.

Beyond that boundary, clean empty reads cannot distinguish “never materialized” from
“evidence aged out”. A second order read in the subsequent CANCEL closes the GET→CANCEL
race but does not repair aged-out evidence. Therefore both the fifth-state GET and the
ambiguous-CREATE CANCEL confirmation need the same freshness and execution-evidence gate.

ABI already has everything needed without a new durable field: immutable
`current_binding_started_at`, the public `getServerTime()` transport primitive, and the
paginated exact-own execution resolver keyed by `orderLinkId`. Runtime requires no clock
or marker-schema change.

## Goals / Non-Goals

**Goals:**

- Expose `entry_order_not_found` only for a fresh unresolved ambiguous CREATE binding.
- Require the entire existing recovery retry budget to remain strictly clean-empty.
- Consult exact-own execution evidence so an attributable fill always blocks absence.
- Prevent the corrective CANCEL from persisting `absent` when its evidence is aged out.
- Preserve the GET as exchange-read-only and keep all positive existing states dominant.

**Non-Goals:**

- Generalizing clean not-found for applied, pending-cancel, legacy amend/replace, or other
  non-terminal records.
- Treating age, aggregate flatness, or absence alone as terminal proof.
- Resending/reconstructing CREATE or changing Runtime durable state.
- Changing existing behavior when a live, terminal, or filled own order is positively
  found.
- Logging `createOrder()` exceptions; that remains a separate observability micro-change.

## Decisions

### 1. Exact ambiguous-CREATE eligibility is structural and narrow

The fifth-state candidate is enabled only when all of these durable conditions hold:

1. `status` is `pending_create` or `unknown`;
2. `pending_action` is exactly `create`;
3. `order_link_id` is a non-empty string;
4. `current_binding_started_at` is a valid ISO timestamp;
5. `desired_entry` remains non-null;
6. `first_fill_at_ms`, `close_order_link_id`, and `close_order_id` are null;
7. `early_execution_observation` is null, so no durable order/fill observation already
   supersedes the candidate.

Any applied, pending-cancel, create-failed, legacy amend/cancel-and-create, durably
terminal, or structurally incomplete record retains existing behavior and can never emit
the fifth state. This intentionally favors false-negative recovery over broad absence
inference.

### 2. The existing full retry budget becomes one cumulative absence observation

The resolver does not return on the first `not_found`. For each of the three existing
attempts it performs:

1. strict exact-own realtime/history order classification;
2. when order classification is clean `not_found`, complete paginated exact-own execution
   resolution using the same `orderLinkId`;
3. the existing aggregate position sanity read.

An order or fill found on any attempt immediately follows the existing positive-state
logic and supersedes earlier absence. An attributable execution prevents the fifth state
even if an order row is absent; if existing response fields are insufficient to construct
`position_open`, the request fails closed rather than misreporting absence. Any query
failure, malformed envelope/item, identity/category/symbol mismatch, incomplete execution
pagination, unrecognized result, or non-flat aggregate position taints the cumulative
absence candidate. Later empty reads cannot erase that taint, although a later positive
finding is still honored.

Only three clean order-absent + complete no-execution + clean-flat attempts can proceed
to freshness validation. The retry count and delay do not change.

### 3. Freshness is measured by Bybit time and checked after observation

After the third clean attempt, ABI reads the official
[Server Time](https://bybit-exchange.github.io/docs/v5/market/time) endpoint and strictly
decodes a Bybit server timestamp. The binding is eligible only when:

`0 <= serverNowMs - Date.parse(current_binding_started_at) < 604800000`.

Seven days is not an invented policy value: it is the documented default window for both
queried history endpoints and the documented Demo order-retention duration. Strict `<`
avoids claiming coverage at the retention boundary. Checking after the full observation
ensures the entire completed decision still lies inside the window. Invalid/future
binding time, server-time failure, or age at/above seven days yields existing
`internal_error`, never the fifth state.

The current order/execution adapter requests need no `startTime`/`endTime`: while the
binding is strictly inside the current seven-day window, their documented default window
covers its entire possible lifetime. This avoids implying support for historical slicing
that the existing primitives do not expose.

### 4. Execution evidence reuses the existing exact-own paginated primitive

Reuse `resolveFirstAttributableFillAtMs()` or extract its complete-page exact-own core so
the fifth-state path gets the same properties: server-side `orderLinkId` filtering,
category/symbol decoding, Trade-only items, cursor-to-completion, and ambiguous result on
transport/protocol failure or page-cap exhaustion.

For this capability the result is interpreted as:

- `found` → never `entry_order_not_found`;
- `ambiguous` → fail closed;
- `no_executions_found` → one necessary, not sufficient, absence signal.

No aggregate execution, inferred fill, or order-id lookup is introduced.

### 5. Corrective CANCEL must repeat the same proof before durable absence

When `desired_entry:null` targets a record that still has the ambiguous-CREATE structural
shape, clean order absence may reach `EntryPackageAbsent` only after the CANCEL request
itself completes the same three-attempt order/no-execution observation and passes the same
post-observation Bybit-time freshness gate.

If a live order appears, existing exact cancel behavior applies. If terminal/fill evidence
appears, existing positive handling applies and absence is not fabricated. If evidence is
ambiguous or the binding is no longer strictly within seven days, ABI returns safe error,
does not persist `status:"absent"`, and leaves Runtime's marker intact.

This additional gate is scoped only to clean-absence confirmation for the ambiguous
CREATE shape. Other already-durable absence, positively terminal orders, and ordinary
cancellation confirmation retain their existing contracts.

### 6. Public semantics remain observation then explicit action

`entry_order_not_found` carries null applied package and fill facts and is not persisted
as a terminal ABI fact. Recovery GET never writes to the exchange. Runtime may use the
observation to invoke one explicit existing CANCEL, but only that second request's fresh
formal `EntryPackageAbsent` can clear Runtime state.

### 7. Deploy Runtime decoder before ABI emission

Runtime-first is backward compatible: it recognizes the fifth state but sees only the
existing four until ABI is upgraded. ABI-first is safe but leaves old Runtime treating
the new member as a protocol error, so coordinated rollout should be Runtime-first.

## Risks / Trade-offs

- [A genuine absence reaches the seven-day boundary before confirmation] → Fail closed;
  no marker is cleared. Safety takes precedence over eventual automatic recovery.
- [A query transiently fails, then later reads empty] → The cumulative observation stays
  tainted and cannot emit the fifth state in that request; a later request starts a fresh
  bounded budget.
- [An order/fill appears after an earlier empty attempt] → Positive evidence supersedes
  absence immediately.
- [GET succeeds just before expiry but CANCEL runs after expiry] → CANCEL repeats the
  post-observation freshness check and refuses durable absence.
- [Execution exists but order history is empty] → Exact execution evidence blocks the
  fifth state; ABI fails closed unless existing facts can positively resolve another
  state.
- [The two incident markers are not processed before expiry] → They remain stuck and
  require a separately authorized resolution path; this change never weakens the evidence
  rule to recover them.

## Migration Plan

1. Deploy the paired Runtime decoder/resolver change first.
2. Deploy ABI without modifying existing correlation records.
3. While each incident binding is still strictly inside the seven-day window, observe the
   complete three-attempt order/execution absence, fifth state, corrective CANCEL's
   repeated gate, exact `EntryPackageAbsent`, and marker clearing.
4. Confirm no old CREATE was resent and only a later genuine bar performs fresh ordinary
   reconciliation.

Rollback is code-only. Any marker not formally cleared remains durable. A marker already
cleared has an ABI `absent` record produced inside the trustworthy window. No schema
migration or manual incident-record edit is needed.
