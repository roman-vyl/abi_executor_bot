## Context

Facts from `main` (fe9a4a8):

- Apply creates one conditional Market entry order with stop-loss and take-profit attached (`tpslMode: Partial`, `bybitOrderMapper.ts`). Separate protection orders appear only after a fill and are tracked elsewhere.
- Every `entry_package_applied` comes from `persistConfirmationOutcome` after `confirmEntryPackage`, on three paths: first create (`confirmAndFinalize`), repeat PUT (`repeatPutRevalidate`) and metadata-only change (`metadataOnlyUpdate`). All three query by the record's `order_link_id`.
- `decodeOrderQueryResponse` rejects a row whose `orderLinkId` differs from the queried one, so the read-back row is the confirmed own order, live or already filled. It does not read `orderId`.
- The record's `order_id` is copied from the create response (`readBybitOrderId`). It stays `null` when the create response was lost and a later repeat PUT confirmed the order, so it is not a confirmed value.

## Decisions

### D1. Two optional fields

`order_link_id` and `order_id` are added to `entry_package_applied`. Each is omitted when not available. All existing fields stay as they are.

### D2. Source

Both come from the confirmation read-back row of the cycle's own entry order: `order_link_id` is the row's `orderLinkId` (already checked equal to the queried one), `order_id` is the row's `orderId`. No extra Bybit request; the record's create-time `order_id` is not used.

### D3. Decoder tolerance

`orderId` is read as an optional string. Absent, empty or non-string means "not reported"; it never turns a found row into a protocol failure, so confirmation and trading behaviour do not change.

### D4. Compatibility

Runtime's decoder rejects unknown keys, so this MUST NOT be deployed before the Runtime change that accepts the two fields.
