## 1. Checks before code

- [ ] 1.1 Check that no consumer decodes ABI `GET /health` with an exact field list (strategy_runtime ABI client, `bbb_stack` compose health checks). If one does, drop the `/health` field from this change and report the state only in events.

## 2. Startup without exit

- [ ] 2.1 Replace `openExchangeFactsStoreOrExit` with `openExchangeFactsStore` returning `disabled` / `enabled` (with store) / `unavailable` (with reason); emit `exchange_facts_store_failed` as today; never call `process.exit`.
- [ ] 2.2 Wire the state in `startServer`: shutdown closes the store only when `enabled`.
- [ ] 2.3 Compute `service_starting.exchangeFactsStore` from the state (`exchangeFactsSchemaVersion` only when `enabled`).

## 3. Lazy native driver

- [ ] 3.1 Remove the module-level `better-sqlite3` import from `src/exchangeFacts/exchangeFactsStore.ts`; load it inside `ExchangeFactsStore.open` via `createRequire`; map a load failure to `exchange_facts_driver_unavailable`; keep type-only imports.
- [ ] 3.2 Add `exchange_facts_driver_unavailable` to `ExchangeFactsOpenFailureReason`.

## 4. Health

- [ ] 4.1 Pass the state to `handleSystemRoutes`; add `exchangeFactsStore` and, when `unavailable`, `exchangeFactsStoreReason` to `/health`; `ok` and status unchanged.

## 5. Tests and docs

- [ ] 5.1 Startup tests: open failure for each reason → event emitted, no exit, state `unavailable`; disabled → open never called.
- [ ] 5.2 Driver tests: injected loader throwing → `exchange_facts_driver_unavailable`; disabled store never calls the loader.
- [ ] 5.3 `/health` tests for `disabled`, `enabled`, `unavailable` with unchanged `ok`/status.
- [ ] 5.4 Update existing tests that expect exit 1 on open failure.
- [ ] 5.5 README: store failure no longer stops ABI; new reason and `/health` field.
- [ ] 5.6 Run `npm run typecheck` and `npm test`.
