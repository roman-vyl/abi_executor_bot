## 1. abi_executor_bot

- [ ] 1.1 Demo check, read only: does `orderStatus=Filled` and `orderFilter=tpslOrder` return partial-mode protection children, and does a `nextPageCursor` walk with `startTime`/`endTime` work as the design assumes. Record the answer in design.md D2.
- [ ] 1.2 Adapter and decoder: `getOrderHistoryForSymbol` accepts `startTime`, `endTime`, `cursor` (and the filters if 1.1 allows); decoder returns `nextPageCursor`.
- [ ] 1.3 `resolveOwnAttachedProtection`: cycle start input, window and cursor walk, early stop, caps, `query_failed` on any incomplete read, coverage flag in the result.
- [ ] 1.4 Callers (`openPositionResolutionService`, `closeApplicationService`) pass the cycle start time.
- [ ] 1.5 D3 (only if the owner confirms): single filled leg classification with the four conditions; update the existing fail-closed test to the new rule.
- [ ] 1.6 Tests: own stop filled then more than 50 later orders, first page without it, lookup finds it and closes the cycle and frees the scope; page boundary inside a window; boundary between two 7-day windows; cap reached gives `query_failed` and no write; failed and malformed page; cursor not advancing; stop found, take-profit absent after 24 h (D3) with complete and incomplete coverage and with a position present; unchanged paths for a recent exit and for an active pair.
- [ ] 1.7 `npm test`, `npm run typecheck`, `openspec validate --strict`.

## 2. Verification on the Mac (on owner's word only)

- [ ] 2.1 Deploy. One demo cycle exits by stop or take-profit after more than 50 later BTCUSDT orders; the lookup returns the closure and the scope frees without manual edits.
