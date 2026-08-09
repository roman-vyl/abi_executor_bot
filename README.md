# ABI Executor Bot

`ABI Executor Bot` — exchange-facing execution boundary между `Strategy Runtime` и Bybit.

Runtime принимает торговые решения и владеет lifecycle trade cycle. ABI не содержит strategy logic. Его зона ответственности — принять Runtime command, нормализовать его до exchange-executable формы, подтвердить фактический exchange state и сохранить собственный durable correlation state о том, что уже было сделано.

## Роль ABI

- Runtime решает, что должно быть на рынке.
- ABI исполняет это решение на Bybit.
- ABI рассчитывает/нормализует executable quantity по текущим trading rules.
- ABI подтверждает результат exchange reads/writes перед success response.
- ABI хранит durable correlation state для replay/recovery.
- ABI не выбирает стратегию, не считает индикаторы и не принимает торговые решения сам.

## Место в Live V1 Pipeline

```text
Strategy Runtime -> ABI Executor Bot -> Bybit
```

Runtime вызывает ABI для четырёх основных задач:

- проверить, открыт ли сейчас position у конкретного trade cycle;
- применить, заменить или убрать desired entry package;
- обновить protection открытой позиции;
- закрыть открытую позицию.

## Runtime-Facing HTTP API

Текущие публичные Runtime-facing операции:

- `PUT /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/entry-package`
  Применяет, заменяет или отменяет desired entry package одного trade cycle.
- `GET /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position`
  Возвращает live-truth open-position state для одного Runtime-owned trade cycle.
- `PUT /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/protection`
  Обновляет stop-loss / take-profit для уже открытой позиции.
- `DELETE /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position`
  Закрывает текущую открытую позицию trade cycle и подтверждает close через existing close pipeline.

Operational endpoints:

- `GET /health`
  Возвращает process health вместе с execution readiness (`entryPackageReady`).
- `GET /execution/mode`
  Показывает effective dry-run/live execution mode и guard state.

Wire contracts лежат в [`docs/openapi/`](docs/openapi/), а behavioral requirements — в [`openspec/specs/`](openspec/specs/).

## Execution Safety

- По умолчанию ABI стартует в dry-run mode.
- Live writes разрешаются только при явном `ABI_LIVE_TRADING_ENABLED=true`.
- `BYBIT_ENV` валидируется fail-closed и не может тихо откатиться на другой environment.
- Mainnet не должен включаться через fallback: invalid config ломает startup.
- Demo/testnet/mainnet guards применяются до live execution path, а не post-factum.

## Durable State And Readiness

- ABI хранит durable correlation state в correlation store, который должен жить вне Docker image.
- На startup выполняется replay/recovery этого store.
- Пока replay не завершился успешно, `entryPackageReady=false`.
- `GET /health` отражает execution readiness: при failed recovery сервис не считается ready/healthy.
- В container path readiness/health завязаны на тот же execution readiness, а не только на факт поднятого HTTP процесса.

## Configuration

Основные переменные окружения:

| Variable | Purpose | Default | Safety semantics |
|---|---|---|---|
| `ABI_HOST` | Host binding для HTTP server | `127.0.0.1` | Локально по умолчанию loopback; container deployment должен явно задавать `0.0.0.0`. |
| `ABI_PORT` | HTTP port | `8787` | Явно невалидное значение ломает startup; fallback есть только для отсутствующего значения. |
| `ABI_DRY_RUN` | Глобальный dry-run flag | `true` | Невалидное явно заданное значение ломает startup; live writes требуют `false`. |
| `ABI_LIVE_TRADING_ENABLED` | Явное разрешение live trading | `false` | Без `true` live writes fail-closed even if dry-run выключен. |
| `ABI_ENTRY_PACKAGE_CORRELATION_PATH` | Путь к durable correlation store | `./var/abi_entry_package_correlation.jsonl` | Должен указывать на persistent path; startup replay/recovery зависит от этого файла. |
| `BYBIT_ENV` | Exchange environment | derived: `testnet` if `BYBIT_TESTNET=true`, otherwise `mainnet` | Явно невалидное значение ломает startup; не используется silent fallback. |
| `BYBIT_API_KEY`, `BYBIT_API_SECRET` | Bybit credentials для live/read access | none | Не нужны для safe local dry-run path; должны подаваться только через runtime env / env file. |
| `ABI_INSTRUMENT_RULES_CACHE_TTL_MS` | TTL кэша trading rules | `300000` | Явно невалидное значение ломает startup. |
| `ABI_BYBIT_REQUEST_TIMEOUT_MS` | Timeout Bybit HTTP requests | `10000` | Явно невалидное значение ломает startup. |
| `BYBIT_ACCOUNT_TYPE`, `BYBIT_RECV_WINDOW`, `BYBIT_CATEGORY`, `BYBIT_SETTLE_COIN`, `BYBIT_TRIGGER_BY` | Основные Bybit runtime defaults | `UNIFIED`, `5000`, `linear`, `USDT`, `LastPrice` | Пустое/невалидное явно заданное значение не должно silently проходить как “почти нормальное”. |

## Local Development

Установка и базовая локальная проверка:

```bash
npm install
npm test
npm run typecheck
npm run build
```

Запуск compiled service:

```bash
npm start
```

Сервис стартует в safe local mode по умолчанию. Быстрая проверка:

```bash
curl "http://127.0.0.1:8787/health"
curl "http://127.0.0.1:8787/execution/mode"
```

## Docker

Текущий Docker path — standalone ABI service, а не будущий общий multi-service stack.

Запуск:

```bash
docker compose up --build
```

Что делает текущий Compose:

- публикует сервис на `127.0.0.1:8787`;
- внутри контейнера явно задаёт `ABI_HOST=0.0.0.0`;
- стартует с safe defaults: `ABI_DRY_RUN=true`, `ABI_LIVE_TRADING_ENABLED=false`, `BYBIT_ENV=testnet`;
- монтирует persistent state как `./var:/app/var`;
- проверяет readiness через `GET /health`;
- останавливает сервис через normal shutdown path (`SIGTERM` -> HTTP server close -> process exit).

## Verification

Основные команды репозитория:

```bash
npm test
npm run typecheck
npm run build
npm run validate:openapi
openspec validate --strict --all
```

## Repository Orientation

- `src/app` — composition root, HTTP server startup, readiness и shutdown wiring.
- `src/routes` — thin HTTP boundaries для Runtime-facing и operational endpoints.
- `src/services` — use-case orchestration для entry-package, open-position, protection и close.
- `src/exchange` — Bybit adapter, mappers и exchange-specific decoding/resolution.
- `src/risk` — position sizing и quantity normalization against trading rules.
- `src/correlation` — durable correlation store, replay/recovery и scope ownership reconstruction.
- `src/domain` — transport/domain validation, result envelopes и core typed contracts.
- `test` — unit/integration/contract verification suite и fakes.
- `openspec` — canonical behavioral specs и archived/planned changes.

## Related Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — deeper component and flow detail.
- [docs/RUNBOOK.md](docs/RUNBOOK.md) — operational runbook and smoke procedures.
- [docs/openapi/](docs/openapi/) — current HTTP wire contracts.
- [openspec/specs/](openspec/specs/) — canonical behavioral requirements.
