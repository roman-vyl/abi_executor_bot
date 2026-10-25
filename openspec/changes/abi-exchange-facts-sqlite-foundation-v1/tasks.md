## 1. abi_executor_bot

- [ ] 1.1 Add `better-sqlite3` exactly `12.9.0` and `@types/better-sqlite3` (dev) with the lockfile. Verify `npm ci` in `node:20-bookworm-slim` for `linux/amd64` and `linux/arm64` installs a prebuilt binary without a compiler. If a compile is needed, stop and report to the owner (D2).
- [ ] 1.2 Config `ABI_EXCHANGE_FACTS_ENABLED` (default `false`, invalid fails) and `ABI_EXCHANGE_FACTS_DB_PATH` (default `./var/abi_exchange_facts_<BYBIT_ENV>.sqlite3`); `.env.example`.
- [ ] 1.3 `src/exchangeFacts/`: open with pragmas in the D7 order; schema and `schema_meta` (D1); environment, category, storage schema, version and dedup rule checks (D6); close.
- [ ] 1.4 Fact writes (D3, D4): dedup keys with the normalized fingerprint, `exec_type`, empty identifiers to `NULL`, raw record text kept; typed errors for missing key fields; one transaction per call; inserted/duplicate counts.
- [ ] 1.5 Link writes (D5): one row per `orderId`, `link_seq` counter, evidence values, duplicate, `link_conflict`, `parent_not_found`, `parent_ambiguous`.
- [ ] 1.6 `readFactsAfter` / `readLinksAfter` (D7).
- [ ] 1.7 `server.ts`: open before listening only when enabled, close on shutdown; `service_starting` fields and `exchange_facts_store_failed` event. No call from entry, protection, close or recovery.
- [ ] 1.8 Tests on temporary directories only: disabled creates no file; new file schema and meta; reopen v1; environment mismatch, unknown database, newer schema and unknown dedup rule refused; no `-shm` file while open; raw JSON byte equality on recorded rows of trade 6072511f (entry order, SL child with `parentOrderLinkId`, deactivated TP, entry execution, SL execution, funding); Funding stored as `execution` with `exec_type`; same `execId` from WS then REST; same order snapshot with `3.8180` / `3.818`; stop moved with same status, `cumExecQty` and `updatedTime` kept; missing `execId` rolls back the batch; entry + two children linked; identical link; `link_conflict`; two `orderId`s with the same `orderLinkId`; child without parent and with ambiguous parent; `event_seq` and `link_seq` monotonic across reopen; late fill read after cursor; crash test (child process writes batches and prints each acknowledged batch id after commit, `SIGKILL` at a random moment, repeated 20 times; after each: `integrity_check` ok, every acknowledged batch complete, no partial batch, new `event_seq` above the old maximum); existing test suite unchanged.
- [ ] 1.9 `npm test`, `npm run typecheck`, `openspec validate --strict`; RUNBOOK (enable flag, one file per environment in `BBB_data/abi`, one database per account and moving it aside on account change, one ABI per data directory, EXCLUSIVE is not a guard, no outside reader, backup only with ABI stopped), ARCHITECTURE (internal storage, future read-only API as the only contract).

## 2. Rollout (on owner's word only)

- [ ] 2.1 PR and merge only on the owner's word; deploy with the store disabled (no behavior change).
- [ ] 2.2 Enabling the store on the Mac demo is a separate step on the owner's word (env in `bbb_stack`).
