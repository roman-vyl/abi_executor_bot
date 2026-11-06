## 1. Общая проверка execution-фактов — только после отдельного Apply

- [ ] 1.1 Добавить один небольшой verifier: terminal exchange status и positive final cumExecQty из одного authoritative proof до любых SQLite reads, identity/role/generation, raw/normalized agreement, execId deduplication, exact sum against authoritative cumExecQty, min(execTime), bounded read with explicit truncation rejection; optional store и безопасные причины unavailable.
- [ ] 1.2 Покрыть single fill терминального entry, несколько partial fills терминального ордера вне порядка, terminal cancellation после partial fill, одинаковые дубли WS/REST, конфликт execId, отсутствующий ранний fill, превышение суммы, неправильные orderId/orderLinkId/symbol/side/cycle/role/generation, malformed time/qty, missing link/orderId и достижение read limit при видимой достаточной сумме.

## 2. Подключение в существующие capture paths

- [ ] 2.1 В open-position передать минимальный authoritative proof-context существующего lookup; saved timestamp → existing REST capture → verifier только при неуспехе REST. Сохранить closure priority, response identity, pair mutex/re-read и best-effort first-fill-only write semantics.
- [ ] 2.2 Подключить тот же компонент в position_open и terminal_after_fill recovery capture без изменения convergence/terminal best-effort, REST-first и статусов.
- [ ] 2.3 В composition root передать optional read-only store capability; при успешном REST не читать SQLite вообще; disabled/open/read failure сохраняет исходный REST failure, не меняет authorization/readiness и не запускает новые workers.

## 3. Регрессии и приёмка

- [ ] 3.1 Fake integration обоих сервисов: delayed/empty REST executions + complete local proof → прежний успешный контракт; REST-success → ноль SQLite reads; REST-failure + unavailable/incomplete/truncated/conflicting local data → прежняя branch-specific семантика; empty/error REST без local proof → прежняя branch-specific семантика. Проверить отсутствие дополнительных order/position queries и любых новых exchange writes.
- [ ] 3.2 Проверить closure до lookup и между initial read/locked capture, смену generation, уже сохранённый first_fill, гонку live PartiallyFilled: confirmed cumExecQty=2, ранний fill 2 отсутствует, поздний fill 2 уже в SQLite — ноль SQLite reads и прежний REST-отказ; неизвестную терминальность и несогласованные status/quantity snapshots, существующие ошибки persistence/convergence. Локальный fill не переоткрывает закрытый цикл.
- [ ] 3.3 Выполнить npm test, npm run typecheck, npm run build, npm run validate:openapi и strict OpenSpec validation; опубликовать diff и результаты для ревью. Проверить отсутствие изменения HTTP-контрактов, Runtime, Docker, close, схем журналов и Mainnet guard.

Merge/deploy и реальный Demo smoke не входят в этот Apply и требуют отдельного разрешения. Сейчас выполняется только подготовка спека; все implementation tasks остаются открытыми.

## 4. Измерения перед отдельным разрешением Deploy

- [ ] 4.1 Подготовить ограниченный воспроизводимый нагрузочный smoke на отдельной consistent копии рабочего объёма SQLite в эквивалентном Mac/Docker storage. Только владелец тестовой базы, синтетические WS batch writes, без real credentials/торговли/нагрузки на действующий Demo. Задать длительность, rates, размеры/read-limit, cold/warm сценарии.
- [ ] 4.2 Сопоставить baseline без SQLite verification reads и REST-empty fallback под одновременной записью WS. Опубликовать p50/p95/p99/max SELECT/link и verifier, event-loop lag, WS receive/process/flush latency, drops/backlog, sample counts, ошибки и конфигурацию среды без account payload.
- [ ] 4.3 Получить отдельное ревью измерений и допустимости регрессии до Deploy. Не выдавать try/catch за защиту от долгого sync SELECT; не вводить очередь/worker/блокировки без нового решения. Функционально успешный smoke сам по себе Deploy не разрешает.
