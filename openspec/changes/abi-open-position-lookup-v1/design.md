## Context

See proposal.md - Why. This design closes every open question left by the prior
exploration (`docs/OPEN_POSITION_LOOKUP_EXPLORE.md`), which is read as evidentiary
architectural basis, not copied wholesale. Confirmed by reading the current code:

- `EntryPackageCorrelationRepository.get(strategyInstanceId, tradeCycleId)`
  (`src/correlation/entryPackageCorrelationRepository.ts:83-85`) is a direct `Map` lookup
  on the exact composite key the entry-package PUT route already writes under — reused
  as-is, no index change.
- `EntryPackageExecutionStatus` has exactly eight values
  (`src/correlation/entryPackageExecutionRecord.ts:4-12`): `pending_create`, `applied`,
  `pending_replace`, `pending_cancel`, `absent`, `create_failed`, `unknown`,
  `terminal_unfilled`.
- `BybitPosition` (`src/exchange/bybitAdapter.ts:16-21`) carries only
  `symbol`/`side`/`size`/`positionIdx`; `readOpenPosition()` (`bybitAdapter.ts:348-377`)
  discards `avgPrice`/`openTime` even though Bybit's `/v5/position/list` response
  includes them.
- `getOpenPositions()` (`bybitAdapter.ts:106-114`) always sends
  `category: this.config.bybitCategory`, the deployment's global value, never a
  caller-supplied one.
- Existing route matching (`src/routes/entryPackageRoutes.ts:104-146`) uses a flat
  segment-count-and-literal check with `decodeURIComponent` per opaque path value,
  producing `EntryPackageValidationDetail[]` on failure — the pattern this route reuses.
- Existing error envelope: `EntryPackageErrorResponse` = `{ error: { code, message,
  details? } }` (`src/domain/entryPackageApi.ts:43-60`), with `EntryPackageErrorCode` =
  `malformed_json | unsupported_media_type | validation_failed | internal_error`, mapped
  1:1 to `400 | 415 | 422 | 500`.
- `entry-package-execution`'s own established precedent for "cannot durably classify
  exchange truth right now" is to return a safe `internal_error`, never to guess (e.g.
  "Ambiguous confirmation fails safely", "A query failure is never treated as confirming
  evidence"). This design follows that same precedent rather than inventing a different
  failure style for this new route.

## Goals / Non-Goals

**Goals:**
- Fully specify record-state classification into three disjoint buckets (durably closed /
  live-query-admissible / fail-closed-unresolved) covering all eight statuses plus the
  missing-record case, so no branch is left to implementer judgment.
- Fully specify the Bybit typed-adapter boundary's input, output, and every validation
  failure mode.
- Fully specify a minimal, closed, reused-where-possible error-code vocabulary with an
  exact HTTP mapping for every fail-closed branch.

**Non-Goals:**
- No change to `EntryPackageCorrelationRepository`'s schema, index, or write path.
- No change to the entry-package PUT flow, its confirmation logic, or its own error
  vocabulary beyond additive reuse.
- No change to legacy `/signals`, `/intents/*`, or `accountRoutes` behavior, and no change
  to the existing `getPosition(symbol)` method those paths use today (post-create
  protection verification's spec explicitly requires those to stay unaffected).
- No Runtime-repo design. Runtime's required changes are named (proposal.md, §"Runtime
  dependency" below) but not designed here.

## Decisions

### 1. Record resolution is a single direct composite lookup; a missing record is a fail-closed business rejection, never `position_open: false`

`open-position-resolution` calls `EntryPackageCorrelationRepository.get(strategy_instance_id,
trade_cycle_id)` exactly once per request — the existing method, unchanged. There is no
secondary index, no `strategy_instance_id`-only lookup, and no cardinality handling: the
pair is a single-record key by construction, so the result is either the one record or
nothing.

When the result is `undefined`, this is classified as an **ownership/invariant mismatch**,
not as a closed position. Runtime's full ownership model means it should never ask about a
pair it hasn't already registered via the entry-package PUT route; a missing record either
means Runtime asked prematurely (a genuine client-side sequencing bug) or ABI's durable
state diverged from Runtime's — both are conditions Runtime needs to investigate, not a
fact about the exchange. This maps to the new `unknown_trade_cycle_binding` code (Decision
4), HTTP `422`, never HTTP `404` and never a `200` closed-position body — the client
contract already documented for this capability's own consumer (Runtime) explicitly
forbids reading `404` as "no position" (`docs/OPEN_POSITION_LOOKUP_EXPLORE.md:122-123`),
and returning `200 { position_open: false, ... }` here would actively hide a real
ownership defect behind a plausible-looking closed-position answer.

### 2. Record-state classification: three disjoint buckets over the eight statuses

Once a record is found, `open-position-resolution` classifies it by `status` into exactly
one of three buckets before doing anything else. This directly closes the exploration
report's open item; the assignment below is the design decision (not merely reused from
the report):

**Bucket A — durably proves no exchange exposure ever existed for the current binding;
return `200 { position_open: false, first_fill_at_ms: null, average_entry_price: null }`
directly, with no Bybit call:**
- `absent` — ABI has durably confirmed no order is live for this trade cycle (either
  nothing was ever created, or a cancellation was durably confirmed).
- `terminal_unfilled` — the last order for this trade cycle became terminal
  (rejected/cancelled/deactivated) without ever filling; `entry-package-execution`
  already treats this as a durable, settled conclusion (it blocks further non-null
  requests rather than silently retrying).

These are trusted only for their **negative, structural** claim ("no exposure could exist
under the current binding"), which is different from trusting `status` as a **positive**
position indicator (barred by the proposal's position semantics) — no future fill can
retroactively attach to an order this record durably records as never-live or
terminal-without-fill.

**Bucket B — an order exists (or existed) under a stable, already-known
`exchange_category`/`exchange_symbol`; a live Bybit query is admissible and required:**
- `applied` — the only status that can mean pending-unfilled, partial-fill, or full-fill;
  only a live query distinguishes these.
- `pending_replace` — an amend-in-place or cancel-and-create replacement is in flight for
  an existing binding; the traded instrument (`ticker`, hence `exchange_symbol`/`category`)
  is fixed at first application and does not change on a side flip, so the record's stored
  category/symbol remain trustworthy to query against regardless of which replace path is
  underway.
- `pending_cancel` — a cancel is in flight for a previously-live order; a live query
  reports the true current state whether or not the cancel has landed yet (including the
  correct answer if a fill actually raced the cancel).

**Bucket C — unresolved/ambiguous; fail closed without attempting a Bybit query, mapped to
`internal_error` (HTTP `500`):**
- `pending_create` — no prior confirmed binding exists yet for this record; ABI itself
  cannot yet distinguish "never sent," "sent, unconfirmed," and "sent and already filled."
  `entry-package-execution` resolves exactly this ambiguity through its own bounded
  resend/reconfirm machinery on a repeat PUT (`docs/OPEN_POSITION_LOOKUP_EXPLORE.md` §2,
  "Retrying an ambiguous attempt reuses the same identity") — a passive, single-shot read
  from this route has no equivalent resend capability and must not guess.
- `create_failed` — the last create attempt's failure was not necessarily a clean,
  confirmed absence (`entry-package-execution`'s "An attempt is not resent while its true
  exchange state is merely unclear" scenario is exactly this case); the order may still
  exist under a binding this record does not yet durably own.
- `unknown` — ABI's own bounded confirmation logic already failed to classify this
  record's state; a single unauthenticated-context read query inherits the same
  ambiguity, not new certainty.

A false `position_open: false` from Bucket C would be actively dangerous: Runtime could
decide to place a new entry believing none exists while ABI's own write path is still
mid-flight for the same trade cycle. Since this read-only route has no side effect
available to resolve that ambiguity itself, the only safe answer is to fail closed and
push resolution back to the entry-package PUT flow's own authority.

Bucket B is the only bucket that proceeds to Decision 3's category check and Decision 4's
Bybit query.

### 3. V1 exchange-category scope gate happens before any Bybit call

For a Bucket B record, `open-position-resolution` next requires
`record.exchange_category === "linear"`. Anything else (currently only `"spot"` exists as
an alternative, per `exchangeInstrumentResolver.ts`) fails closed with the new
`unsupported_exchange_scope` code (HTTP `422`) — never queried, never treated as
`position_open: false`. This is a permanent, deterministic scope limit knowable from the
record alone (no exchange call needed to detect it), distinguishing it from the
live-exchange-derived failures in Decision 4, which is why it gets its own 422 business
code rather than falling into `internal_error`.

Bybit one-way position mode (`positionIdx = 0`) and hedge-mode rejection are **not** part
of this gate — they can only be observed from the live response itself (Decision 4).

### 4. Typed Bybit adapter boundary: explicit `{ category, symbol }` in, a structurally valid one-way row or a typed failure out

Two adapter-level additions, both additive and non-breaking to existing callers:

- `GetOpenPositionsInput` gains an optional `category?: string`, defaulting to
  `this.config.bybitCategory` only when omitted. Every existing call site (legacy
  `/signals`, `/intents/*`, post-create-protection-verification) keeps omitting it and is
  unaffected. `open-position-resolution` always supplies it explicitly from
  `record.exchange_category`, never relying on the global default (closes gap G2).
- A new adapter method, conceptually `queryPositionForInstrument({ category, symbol })`,
  wraps `getOpenPositions({ category, symbol })` and performs **all raw-shape and
  structural validation**, independent of any specific trade cycle's expected side:
  - Response is a list; each item is an object — otherwise malformed-list/item failure.
  - Required fields (`symbol`, `side`, `size`, `positionIdx`, `avgPrice`, `openTime`) are
    present on any row being considered — otherwise missing-fields failure.
  - `avgPrice` parses as positive exact-decimal text using the same parser already used
    for entry-package price fields (`src/domain/entryPackageApi.ts`'s exact-decimal
    validator, reused, not reimplemented) — otherwise invalid-decimal or
    zero/negative-price failure.
  - `openTime` parses as a positive integer timestamp — otherwise invalid-timestamp
    failure.
  - Rows with `size == 0` (or absent/zero after parsing) are excluded from consideration,
    **not** a failure — if every row is excluded (or the list is empty), the method
    returns "no position" (not an error), which Decision 5 turns into a legitimate closed
    answer.
  - Among rows with `size > 0`: exactly one row with `positionIdx == 0` is the expected
    shape for V1's one-way scope. Zero such rows alongside any nonzero-`positionIdx` row
    with `size > 0` is a hedge-row failure (unexpected `positionIdx`). More than one
    `size > 0` row (regardless of `positionIdx`) is a multiple-plausible-rows/ambiguous
    failure.
  - Any transport error or timeout from the underlying `getOpenPositions` call is a
    transport failure.
  - On success with no disqualifying condition, returns the single structurally valid row
    (`symbol`, `side`, `size`, `positionIdx: 0`, `avgPrice`, `openTime`) or an explicit
    "no position" result.

  This method does **not** know or check `record.desired_entry.side` — that is
  Runtime-trade-specific context the adapter boundary has no business holding.

- `BybitPosition` gains optional `avgPrice?`/`openTime?` fields, and `readOpenPosition()`
  (the existing, legacy-path parser) best-effort-populates them from the same raw row
  without adding new failure modes to its existing lenient behavior — closes gap G3
  without changing legacy behavior, since no existing caller reads these new fields.

### 5. `open-position-resolution` owns the one remaining business check (side match) and response assembly

For a Bucket B record whose category gate passed:
1. Call the Decision-4 adapter method with `{ category: record.exchange_category, symbol:
   record.exchange_symbol }`.
2. Any typed adapter failure (transport, malformed, missing fields, invalid decimal,
   invalid timestamp, zero/negative price, hedge row, ambiguous rows) → fail closed,
   `internal_error`, HTTP `500`. Never `position_open: false` on a query failure — mirrors
   `entry-package-execution`'s existing "a query failure is never treated as confirming
   evidence" discipline.
3. "No position" result → `200 { position_open: false, first_fill_at_ms: null,
   average_entry_price: null }`. A partial fill (`size > 0`, however small relative to the
   intended order quantity) already counts as open; there is no minimum-fill threshold and
   no wait for full execution.
4. A structurally valid row → compare `row.side` (mapped `Buy`/`Sell`) against
   `record.desired_entry.side` (`long`/`short`). Mismatch → fail closed, `internal_error`,
   HTTP `500` (wrong-side failure; this is exchange-observed state, not a deterministic
   record-level scope fact, so it does not get its own 422 code — see Decision 6).
5. Match → `200 { position_open: true, first_fill_at_ms: row.openTime,
   average_entry_price: row.avgPrice }`, with `average_entry_price` passed through as the
   exact JSON string already validated by the Decision-4 adapter boundary — never
   round-tripped through a binary float.

`early_execution_observation` is not read anywhere in this flow.

### 6. Error taxonomy: two new business codes, everything else reuses `internal_error`, same envelope shape

A new `OpenPositionErrorCode` type is added alongside `EntryPackageErrorCode`, reusing the
identical closed envelope shape (`{ error: { code, message, details? } }`,
`EntryPackageValidationDetail`'s `{ path, message }` shape for `details`) but scoped to
this route's actually-reachable codes (no request body, so `malformed_json` and
`unsupported_media_type` are not applicable here):

| HTTP | Public error code | Meaning | Branches |
|---:|---|---|---|
| 200 | *(n/a, success)* | Closed-object success DTO | Decision 1 n/a; Bucket A; Bucket B "no position"; Bucket B match |
| 422 | `validation_failed` | Path parameter invalid (reused as-is, identical to the entry-package PUT route) | Empty or malformed-percent-encoded `strategy_instance_id`/`trade_cycle_id` |
| 422 | `unknown_trade_cycle_binding` **(new)** | No correlation record exists for the supplied pair | Decision 1 |
| 422 | `unsupported_exchange_scope` **(new)** | Record's `exchange_category` is not `linear` | Decision 3 |
| 500 | `internal_error` | Reused as-is: every state or exchange condition that cannot be safely resolved | Bucket C (`pending_create`, `create_failed`, `unknown`); any Decision-4 adapter failure (transport, malformed, missing fields, invalid decimal, invalid timestamp, zero/negative price, hedge row, ambiguous rows); Decision-5 side mismatch |

Rationale for exactly two new codes, not more: `unknown_trade_cycle_binding` and
`unsupported_exchange_scope` are both deterministically knowable **before** any exchange
call, from the record alone, and both represent conditions Runtime should treat as
"stop and investigate" rather than "transient, maybe retry" — genuine operational value in
letting Runtime's error handling/alerting distinguish them from a generic
`validation_failed` (which the existing entry-package route reserves for malformed request
shape, not for a well-formed request about an unknown/out-of-scope pair) and from
`internal_error` (reserved for genuinely live-exchange-derived or ABI-internal-state
uncertainty, matching the precedent already established by `entry-package-execution`).
Every other fail-closed branch reuses `internal_error` rather than minting further public
codes, since Runtime's existing client contract already treats any `5xx` uniformly as
"unavailable" and does not need finer-grained decoding for those cases
(`docs/OPEN_POSITION_LOOKUP_EXPLORE.md:123-126`). No response ever includes the raw Bybit
body, an internal exception, or a stack trace — `error.message` is a short, safe,
static-per-code string, matching the existing `internal_error` convention in
`src/domain/entryPackageApi.ts`.

Runtime distinguishes "business rejection" (`422`, something to fix or investigate before
retrying the same pair) from "unavailable" (`500`, plausibly transient) using the same
two-bucket HTTP-status decoding its existing client contract already documents for
`400`/`422` vs `5xx` — no new decoding rule is required on the Runtime side beyond
recognizing the new path and field names (proposal.md's Runtime dependency).

### 7. HTTP route and path decoding mirror the entry-package pattern exactly

`GET /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position`
is matched with the same flat segment-count-and-literal-check approach as
`matchEntryPackageRoute` (`src/routes/entryPackageRoutes.ts:104-146`): split on `/`,
require exactly 7 segments with the fixed literals in position, `decodeURIComponent` each
opaque path segment individually (catching malformed percent-encoding per segment), and
reject empty-after-decoding values — all as `validation_failed` with
`EntryPackageValidationDetail`-shaped `details` identifying `/path/strategy_instance_id` or
`/path/trade_cycle_id`. No request body is read (`GET`); no content-type check applies.

### 8. Readiness and composition: reuse existing instances, no new persistence owner

The route reads the same recovered correlation store as the entry-package PUT route, so it
gates on the same existing `EntryPackageReadiness` instance
(`src/app/server.ts:28,46,48,69`) — not ready until `EntryPackageCorrelationRepository`'s
startup replay has succeeded, exactly like the PUT route's existing `isReady` gate. The
route is wired into the same route-chain `if` sequence in `src/app/server.ts`, reusing the
already-constructed `correlationRepository` and `bybit` (`RestBybitAdapter`) instances —
no new repository, no new adapter instance, no new persistence owner. `EntryPackageReady`
readiness failure maps to the same safe `internal_error` response the PUT route already
returns for the same condition (`src/routes/entryPackageRoutes.ts`'s `!isReady()` branch),
reused as-is rather than inventing a distinct not-ready code for this route.

## Risks / Trade-offs

- [Bucket C fails closed for `pending_create`/`create_failed`/`unknown` even though a live
  Bybit query might sometimes happily resolve them] → Accepted: a wrong `false` in these
  states risks a duplicate live entry, which is a worse outcome than an occasional `500`
  Runtime must handle as "unavailable, don't decide yet." These states are also expected
  to be short-lived in practice (mid-flight or already-terminal-pending-retry), so this is
  a narrow window, not a persistent blind spot.
- [Two new public error codes add a small amount of vocabulary Runtime's client must at
  least tolerate generically] → Mitigated by keeping both at `422`, the same status
  Runtime's existing client contract already decodes as a generic business rejection; no
  new HTTP status is introduced, so an unmodified generic `4xx` handler still behaves
  correctly even before Runtime adds specific handling for the new codes.
- [Side-match failure (Decision 5) is classified as `internal_error` rather than a
  dedicated business code, even though it is somewhat deterministic once observed] →
  Accepted: unlike category (known purely from the record, before any exchange call), the
  side mismatch can only be observed via the live query, so it shares the same
  "live-exchange-state-derived uncertainty" character as the other `internal_error`
  branches (hedge row, ambiguous rows) rather than the "known in advance from the record"
  character of `unsupported_exchange_scope`.
