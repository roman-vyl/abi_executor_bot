## 1. Storage schema v2

- [x] 1.1 Add `account_snapshots`, `stream_connection_log`, `snapshot_key_version`; new databases at v2; in-place v1 → v2 upgrade in one immediate transaction; refuse versions > 2 and unknown key versions.
- [x] 1.2 Store API: one flush call writing facts, snapshots and log rows in one transaction; snapshot dedup keys (position, wallet); reads after `snapshot_seq` / `log_seq` for tests.
- [x] 1.3 Tests: v1 file upgraded with rows kept; v2 reopened unchanged; v3 refused; snapshot dedup; mixed flush rollback; crash test still passes.

## 2. Recorder

- [x] 2.1 Add `ws` (exact pin) and `@types/ws`.
- [x] 2.2 `ExchangeStreamRecorder`: URL per environment, auth signature, subscribe, ping 20 s, liveness 60 s, backoff 1/2/5/10/30 s with reset after 60 s subscribed.
- [x] 2.3 Frame mapping (D4), bounded buffer and flush (D5), failure handling (D6), events (D8).
- [x] 2.4 Wire in `startServer`: start only when store `enabled` and key configured; stop and final flush on shutdown before the store closes.
- [x] 2.5 `/health.exchangeStream`.

## 3. Tests

- [x] 3.1 Local fake Bybit WS server (`ws` server in tests): auth message and signature, subscribe args, records of all four topics stored after flush.
- [x] 3.2 Replayed stage 0 frames (XRPUSDT stop loss 2026-10-27 12:47:54Z, entry create/cancel 19:30–19:35Z) stored as 2 + 1 facts and 3 order states; duplicate `execId` after reconnect stored once.
- [x] 3.3 Drop (server closes 1006), stale connection, auth failure, subscribe failure: connection log rows and backoff (short test intervals against a local server).
- [x] 3.4 Invalid record in a batch, store write failure, buffer overflow: no exception leaves the recorder; `/health` reflects it; the full existing test suite (trading routes included) stays green.
- [x] 3.5 Recorder not started when store disabled/unavailable or no key.
- [x] 3.6 `npm run typecheck`, `npm test`, `npm run validate:openapi`, `openspec validate --all --strict`.

## 4. Docs and rollout

- [x] 4.1 RUNBOOK: what the recorder records, how to read coverage gaps from the connection log, that funding is not pushed on Demo WS.
- [x] 4.2 PR and merge only on the owner's word. Deploy and enabling the store on the Mac demo (`bbb_stack` env) are separate steps on the owner's word; after enabling, compare one day of stored records with Runtime's journal. (Merged #35, deployed on the Mac demo 2026-10-28 19:03 UTC; the one-day comparison waits for the first trades and is not done at archive time.)
