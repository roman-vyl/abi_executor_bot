## 1. Label index

- [ ] 1.1 `EntryPackageCorrelationRepository.listAllRecords()`: read-only listing of the latest record per pair (open and closed); no other change to the correlation module.
- [ ] 1.2 Label index from records: entry and close labels for generations 1..g via `buildEntryPackageOrderLinkId`, cached per pair and generation, ambiguity marked.

## 2. Linker

- [ ] 2.1 `ExchangeOrderLinker` in `src/exchangeFacts/`: 1 s timer, in-memory cursor and link set, startup scan from 0, at most 1000 facts per tick.
- [ ] 2.2 Classification (D3), entries before children in one `writeLinks`, one-by-one fallback on a failed batch, waiting set retried every tick without deadline (D4).
- [ ] 2.3 Failure handling and events (D6, D7).
- [ ] 2.4 Wire in `startServer`: create only when the store is `enabled`, start after the correlation replay, stop before the store closes.
- [ ] 2.5 `/health.exchangeLinker`.

## 3. Tests

- [ ] 3.1 Stage 0 frames (XRPUSDT entry, PartialStopLoss, PartialTakeProfit, stop fill) with a correlation record: three links of one cycle; execution attributed by `order_id`.
- [ ] 3.2 Close order, earlier generation after a replace, closed cycle, child before entry, unknown child type, foreign label, no label, funding.
- [ ] 3.3 Restart: no duplicate writes, waiting and not linkable sets rebuilt identically; a child waiting for hours is linked in the tick after its entry record is stored.
- [ ] 3.4 Link conflict, write failure: other orders linked, health and events; trading route tests stay green; linker not created with store disabled/unavailable.
- [ ] 3.5 Label pin: the index uses the same function as trading (a label built by the entry path is resolved).
- [ ] 3.6 `npm run typecheck`, `npm test`, `npm run validate:openapi`, `openspec validate --all --strict`.

## 4. Docs and rollout

- [ ] 4.1 RUNBOOK: what is linked, what is waiting or not linkable and why, how to read `exchangeLinker` in health.
- [ ] 4.2 PR and merge only on the owner's word. Deploy and enabling the store on the Mac demo are separate steps on the owner's word.
