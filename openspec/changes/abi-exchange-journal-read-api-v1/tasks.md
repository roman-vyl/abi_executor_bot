## 1. Store reads

- [ ] 1.1 Read events after a sequence with filters (`symbol`, `strategy_instance_id` via `order_links`, `exchange_time_ms` range), `limit + 1` rows (D2, D3).
- [ ] 1.2 Read links after a sequence; link by `order_id`; links by instance and cycle; events by `order_id` with a bound; last `event_seq` and `link_seq` (D4, D5).

## 2. Routes

- [ ] 2.1 `src/routes/exchangeJournalRoutes.ts`: the five `GET` routes, query validation, shapes (D1-D5), errors (D6); wire in `startServer` next to the other routes.
- [ ] 2.2 Event `exchange_journal_read_failed {endpoint, errorCode}`.

## 3. Contract

- [ ] 3.1 `docs/openapi/abi-exchange-journal-api-v1.json`; add it to `scripts/validate-openapi.mjs`.

## 4. Tests

- [ ] 4.1 Feeds: cursor paging while writing, empty page, `has_more`, limits.
- [ ] 4.2 Filters: symbol, strategy, period, unlinked events with `link: null`.
- [ ] 4.3 Order and cycle lookups, `404`, empty cycle, truncation bounds, opaque path values.
- [ ] 4.4 Status for enabled, disabled and unavailable store; `503` on the other endpoints when not enabled.
- [ ] 4.5 Read failure gives `500` and the event; store row counts unchanged after reads; trading route tests green.
- [ ] 4.6 `npm run typecheck`, `npm test`, `npm run validate:openapi`, `openspec validate --all --strict`.

## 5. Docs and rollout

- [ ] 5.1 RUNBOOK: the journal API, how to follow the feeds, example requests.
- [ ] 5.2 PR, merge and deploy only on the owner's word.
