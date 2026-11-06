## 1. Общая проверка execution-фактов — только после отдельного Apply

- [ ] 1.1 Добавить один небольшой verifier: identity/role/generation, raw/normalized agreement, execId deduplication, exact sum against authoritative cumExecQty, min(execTime), bounded read with explicit truncation rejection; optional store и безопасные причины unavailable.
- [ ] 1.2 Покрыть single fill, несколько partial fills вне порядка, одинаковые дубли WS/REST, конфликт execId, отсутствующий ранний fill, превышение суммы, неправильные orderId/orderLinkId/symbol/side/cycle/role/generation, malformed time/qty, missing link/orderId и достижение read limit при видимой достаточной сумме.

## 2. Подключение в существующие capture paths

- [ ] 2.1 В open-position передать минимальный authoritative proof-context существующего lookup; после saved timestamp и до REST вызвать verifier. Сохранить closure priority, response identity, pair mutex/re-read и best-effort first-fill-only write semantics.
- [ ] 2.2 Подключить тот же компонент в position_open и terminal_after_fill recovery capture без изменения convergence/terminal best-effort, REST fallback и статусов.
- [ ] 2.3 В composition root передать optional read-only store capability; disabled/open/read failure не блокирует существующий REST путь, не меняет authorization/readiness и не запускает новые workers.

## 3. Регрессии и приёмка

- [ ] 3.1 Fake integration обоих сервисов: delayed/empty REST executions + complete local proof → прежний успешный контракт; unavailable/incomplete/truncated/conflicting local data → прежний REST path; empty/error REST без local proof → прежняя branch-specific семантика. Проверить отсутствие дополнительных order/position queries и любых новых exchange writes.
- [ ] 3.2 Проверить closure до lookup и между initial read/locked capture, смену generation, уже сохранённый first_fill, частичный fill с продолжающимся входом и изменившимся cumulative snapshot, существующие ошибки persistence/convergence. Локальный fill не переоткрывает закрытый цикл.
- [ ] 3.3 Выполнить npm test, npm run typecheck, npm run build, npm run validate:openapi и strict OpenSpec validation; опубликовать diff и результаты для ревью. Проверить отсутствие изменения HTTP-контрактов, Runtime, Docker, close, схем журналов и Mainnet guard.

Merge/deploy и реальный Demo smoke не входят в этот Apply и требуют отдельного разрешения. Сейчас выполняется только подготовка спека; все implementation tasks остаются открытыми.
