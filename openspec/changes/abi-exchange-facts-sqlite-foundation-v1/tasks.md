## 1. abi_executor_bot

- [ ] 1.1 Add `better-sqlite3` exactly `12.9.0` and `@types/better-sqlite3` (dev) with the lockfile. Verify `npm ci` in `node:20-bookworm-slim` for `linux/amd64` and `linux/arm64` installs a prebuilt binary without a compiler. If a compile is needed, stop and report to the owner (D2).
- [ ] 1.2 Config `ABI_EXCHANGE_FACTS_ENABLED` (default `false`, invalid fails) and `ABI_EXCHANGE_FACTS_DB_PATH` (default `./var/abi_exchange_facts.sqlite3`); `.env.example`.
- [ ] 1.3 `src/exchangeFacts/`: open with pragmas (D5), schema v1 and `schema_meta` (D1), version and contract checks (D6), close.
- [ ] 1.4 Fact writes with dedup keys (D3), empty identifiers to `NULL`, raw item text kept; typed errors for missing key fields; one transaction per call.
- [ ] 1.5 Link writes (D4): evidence values, duplicates, `link_conflict`.
- [ ] 1.6 `readFactsAfter` / `readLinksAfter` (D7).
- [ ] 1.7 `server.ts`: open before listening only when enabled, close on shutdown; `service_starting` fields and `exchange_facts_store_failed` event (observability spec). No call from entry, protection, close or recovery.
- [ ] 1.8 Tests on temporary files: disabled creates no file; new file schema; reopen v1; newer schema and contract mismatch refused; raw JSON byte equality on recorded rows of trade 6072511f (order/history entry, SL child with `parentOrderLinkId`, deactivated TP, execution entry, execution SL, funding); dedup WS then REST; same `orderLinkId` different `orderId`; missing `execId` rolls back the batch; link via parent; `link_conflict`; identical link; `event_seq` monotonic across reopen; late fill read after cursor; existing test suite unchanged.
- [ ] 1.9 `npm test`, `npm run typecheck`, `openspec validate --strict`; RUNBOOK (enable flag, file location `BBB_data/abi`, one ABI per folder, backup only with ABI stopped, exclusive mode), ARCHITECTURE.

## 2. Rollout (on owner's word only)

- [ ] 2.1 PR and merge only on the owner's word; deploy with the store disabled (no behavior change).
- [ ] 2.2 Enabling the store on the Mac demo is a separate step on the owner's word (env in `bbb_stack`).
