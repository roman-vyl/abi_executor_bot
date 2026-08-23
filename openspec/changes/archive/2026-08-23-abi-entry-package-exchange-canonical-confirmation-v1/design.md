## Context

The confirmation decoder already strictly validates response structure, order identity,
status, quantity, and all reported decimal fields. The false ambiguity comes only from a
second step that compares Bybit's valid read-back prices with raw desired-entry text.

## Goals / Non-Goals

**Goals:** Use the accepted write plus strict same-order read-back as confirmation, while
retaining quantity and fail-closed protocol validation.

**Non-Goals:** Predict or reproduce Bybit price canonicalization; add tick-size, rounding,
truncation, tolerance, floating-point logic, API changes, or persistence changes.

## Decisions

Remove desired-entry equality from `triggerPrice`, `stopLoss`, and `takeProfit` confirmation.
Keep those fields in the strict response decoder, and keep exact quantity comparison and
the existing identity/status/query-failure classification. Repeat PUT and metadata-only
revalidation use the same identity/state/quantity evidence without a new exchange write.

## Risks / Trade-offs

- [A successful price-only amend cannot be re-derived locally from read-back text] → The
  accepted amend response proves command acceptance; the bounded same-order read-back proves
  which valid exchange order and state ABI is acknowledging.
- [Relaxing price equality could hide malformed exchange data] → Structural and exact-decimal
  validation remains mandatory and malformed data still fails closed.
