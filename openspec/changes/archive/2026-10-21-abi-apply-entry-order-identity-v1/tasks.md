## 1. abi_executor_bot

- [x] 1.1 `orderQueryResponseDecoder.ts`: read optional `orderId` into `BybitOrderView` per D3; `orderLinkId` of the row is carried too.
- [x] 1.2 `entryPackageApi.ts` and `appliedResult`: optional `order_link_id` and `order_id` from the confirmed row per D1 and D2.
- [x] 1.3 OpenAPI document and `validate-openapi.mjs`.
- [x] 1.4 Tests: first create, repeat PUT and already filled order report the read-back `orderId`, not the create-response one; create response without `orderId` followed by a confirming repeat PUT still reports it; missing or non-string `orderId` omits the field and does not change the outcome; adapter call counts unchanged; non-applied outcomes unchanged.

## 2. Verification on the Mac (on owner's word only)

- [ ] 2.1 Deploy after the Runtime change. One apply on Bybit demo; `order_id` and `order_link_id` in the response match the order in Bybit demo Orders.
