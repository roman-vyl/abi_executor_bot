## 1. Code

- [ ] 1.1 Route `POST /v1/strategy-instances/{sid}/trade-cycles/{tid}/entry-remainder/cancel`: JSON content type, closed empty object body, path ids as in other routes
- [ ] 1.2 `EntryRemainderCancelService`: record lookup, `entry_not_filled`, `terminal_closed` answer, null `order_link_id` → internal_error
- [ ] 1.3 Reuse `classifyEntryOrderTerminality` / `cancelEntryOrder` / `confirmEntryOrderNeutralized` (extract close's `neutralizeEntry` into a shared helper if needed, close behaviour unchanged); `executed_quantity` from the confirmed order
- [ ] 1.4 Server wiring under the pair-level `mutex`
- [ ] 1.5 OpenAPI operation in `abi-position-management-api-v1.json`; README / RUNBOOK paragraph

## 2. Tests (targeted only)

- [ ] 2.1 Body validation: `{}` accepted; extra field, non-object, malformed JSON, wrong content type rejected
- [ ] 2.2 Unknown pair → 422; no first fill → 422 `entry_not_filled`, no exchange call
- [ ] 2.3 PartiallyFilled live → cancel by own orderLinkId, confirmed terminal → `entry_remainder_cancelled` with executed qty
- [ ] 2.4 Filled / Cancelled / PartiallyFilledCanceled → `entry_order_already_terminal`, no cancel sent
- [ ] 2.5 `terminal_closed` record → `entry_order_already_terminal`, no exchange write
- [ ] 2.6 Unconfirmed after bounded reads, query failure, guard skip → 500; no position, protection or child call in any case
- [ ] 2.7 Repeat after success → `entry_order_already_terminal`; close tests unchanged and green; typecheck clean

## 3. Demo acceptance (after deploy, owner word)

- [ ] 3.1 Partially filled touch_trigger Limit: remainder cancelled, position and its one stop + one take (qty = filled) intact
