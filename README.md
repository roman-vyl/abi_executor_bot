# ABI Executor Bot

`ABI Executor Bot` — exchange-facing execution service в составе BBB. Он находится между `Strategy Runtime` и Bybit: получает уже принятое Runtime торговое решение, преобразует его в исполнимые биржевые операции, подтверждает фактическое состояние на Bybit и хранит собственный durable correlation state.

ABI **не содержит strategy logic** и не решает, когда входить или выходить из позиции. Strategy Runtime и Strategy Engine определяют желаемое торговое состояние; ABI отвечает за безопасное выполнение этого состояния на бирже.

## Место ABI в системе

```text
Market Data Service
        |
        | closed bar
        v
Strategy Runtime
        |
        +---------------------> Strategy Engine
        |                       calculation
        |                            |
        |       desired entry /      |
        |       management decision  |
        |<---------------------------+
        |
        v
ABI Executor Bot
        |
        | exchange execution
        | confirmation
        v
      Bybit
```

Основное разделение ответственности:

- **Market Data Service** хранит market data и сообщает о закрытых барах;
- **Strategy Engine** рассчитывает торговое решение;
- **Strategy Runtime** владеет live lifecycle strategy instance и решает, какой execution command нужен;
- **ABI Executor Bot** переводит Runtime command в подтверждённое exchange state;
- **Bybit** является источником фактического состояния ордеров и позиций.

Runtime обращается к ABI для четырёх основных операций:

```text
open-position lookup
entry-package apply / replace / cancel
position protection update
position close
```

ABI не получает от Runtime детали стратегии, рассчитанные индикаторы или внутреннее состояние Engine.

---

## Архитектура ABI

HTTP layer остаётся тонкой границей. Основная execution semantics находится в application services.

```text
Strategy Runtime
      |
      | HTTP
      v
Node HTTP server
      |
      v
Routes
      |
      | validation
      | readiness gate
      v
Application services
      |
      +------------------------+
      |                        |
      v                        v
pair-level mutex        correlation repository
      |                        |
      |                        | durable JSONL
      |                        | indexes / replay
      |                        |
      v                        v
execution decision      current ABI-owned state
      |
      +------------+--------------------+
      |            |                    |
      v            v                    v
instrument     position sizing     Bybit mapping
resolution
      |            |                    |
      +------------+--------------------+
                   |
                   v
              Bybit adapter
                   |
                   v
                 Bybit
                   |
                   | fresh confirmation reads
                   v
           confirmed execution result
                   |
                   v
          durable correlation update
                   |
                   v
              HTTP response
```

Основные application services:

| Component | Responsibility |
|---|---|
| `EntryPackageApplicationService` | apply / replace / cancel entry package |
| `OpenPositionResolutionService` | determine current open-position truth |
| `ProtectionApplicationService` | update and verify position SL/TP |
| `CloseApplicationService` | neutralize entry order, close position and terminalize trade cycle |

Внешний success не означает «запрос в Bybit был отправлен». ABI старается возвращать success только после того, как нужный результат подтверждён fresh exchange reads или уже доказан durable state.

---

# Основные execution flows

## 1. Entry package

Runtime вызывает:

```text
PUT /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/entry-package
```

Типовой путь:

```text
Runtime
   |
   v
entry-package route
   |
   | transport validation
   | readiness check
   v
EntryPackageApplicationService
   |
   | pair mutex
   v
load correlation record
   |
   +-----------------------------+
   |                             |
no previous binding        existing binding
   |                             |
   v                             v
CREATE                 NO-OP / REVALIDATE /
                       AMEND / CANCEL+CREATE /
                       CANCEL
   |
   v
resolve Bybit instrument identity
   |
   v
load current trading rules
   |
   v
calculate executable quantity
   |
   v
persist provisional durable state
   |
   v
Bybit write
   |
   v
fresh realtime/history confirmation
   |
   v
persist confirmed state
   |
   v
response to Runtime
```

`desired_entry = null` означает, что Runtime больше не хочет активный entry package. ABI либо подтверждает уже durable absence, либо нейтрализует текущий entry order и только после подтверждения возвращает соответствующий результат.

Повторный PUT для того же trade cycle не трактуется как совершенно новая независимая операция. ABI использует durable correlation state и deterministic exchange identity, чтобы понимать, какой binding уже существует и что именно требуется подтвердить или изменить.

### Quantity

Текущий V1 sizing — **minimum executable quantity**, а не полноценный risk-based position sizing.

ABI получает актуальные Bybit trading rules и рассчитывает количество, удовлетворяющее как минимум:

- `minOrderQty`;
- `minNotionalValue`;
- `qtyStep`.

Расчёты выполняются через exact-decimal arithmetic без float round-trip.

`risk_multiplier` проходит через Runtime → ABI contract и сохраняется в correlation state, но в текущей V1 формуле sizing ещё не изменяет рассчитанное количество.

---

## 2. Open-position resolution

Runtime вызывает:

```text
GET /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position
```

ABI сначала находит собственный correlation record пары:

```text
strategy_instance_id + trade_cycle_id
```

После этого состояние классифицируется.

```text
correlation record
      |
      +--------------------+---------------------+
      |                    |                     |
durably closed        live-query            unresolved /
                      admissible             inconsistent
      |                    |                     |
      v                    v                     v
position_open=false   query Bybit            fail closed
without Bybit read         |
                           v
                    validate position
                    symbol + side
                           |
                     +-----+-----+
                     |           |
                     v           v
                   OPEN        CLOSED
```

Durable state используется не как замена exchange truth, а чтобы определить, **что именно можно безопасно утверждать и что нужно спросить у Bybit**.

Если record уже доказывает, что exposure невозможен, live query не требуется.

Если состояние допускает существование позиции, ABI получает fresh Bybit position state.

Наличие correlation record само по себе **не означает**, что позиция открыта.

---

## 3. Protection update

Runtime вызывает:

```text
PUT /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/protection
```

Путь:

```text
Runtime protection command
        |
        v
pair mutex
        |
        v
correlation lookup
        |
        v
verify physical-scope ownership
        |
        v
shared open-position determination
        |
        +---------------------+
        |                     |
 position absent         position open
        |                     |
        v                     v
 position_not_open       Bybit trading-stop write
                              |
                              v
                       fresh position read-back
                              |
                              v
                      compare actual SL / TP
                              |
                              v
                      confirmed response
```

ABI не считает новые stop-loss/take-profit значения. Он получает их от Runtime.

Protection считается применённой только после read-back, подтверждающего фактические значения на позиции.

Сам protection update не создаёт отдельную историю management state внутри correlation store: durable management lifecycle остаётся ответственностью Runtime, а ABI подтверждает exchange execution.

---

## 4. Position close

Runtime вызывает:

```text
DELETE /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position
```

Close — это не просто отправка market order.

```text
Runtime close
     |
     v
pair mutex
     |
     v
load correlation record
     |
     v
verify scope ownership
     |
     v
inspect current entry order
     |
     v
neutralize entry order if necessary
     |
     v
confirm entry order terminal
     |
     v
query actual live position
     |
     +----------------------+
     |                      |
 no position           position exists
     |                      |
     |                      v
     |               reduce-only market close
     |                      |
     +----------+-----------+
                |
                v
        fresh final verification
                |
        +-------+-------+
        |               |
position zero     entry order terminal
        |               |
        +-------+-------+
                |
                v
     persist terminal_closed
                |
                v
       release physical scope
                |
                v
       confirmed response
```

ABI закрывает **фактически наблюдаемый остаток позиции**, а не предполагаемое количество из первоначального entry package.

`terminal_closed` записывается только после подтверждения обеих postconditions:

- attributed entry order больше не способен создать новую позицию;
- текущая позиция на соответствующем scope равна нулю.

После этого trade-cycle binding считается окончательно закрытым и не может быть заново активирован новым entry-package command для той же пары.

---

# Durable correlation state

ABI владеет собственным append-only JSONL correlation store.

По умолчанию:

```text
./var/abi_entry_package_correlation.jsonl
```

Главная запись:

```text
EntryPackageExecutionRecord
```

Она относится к одной паре:

```text
strategy_instance_id
+
trade_cycle_id
```

и содержит ABI-owned execution facts, включая:

- Runtime ticker;
- resolved exchange symbol/category;
- applied `desired_entry`;
- `risk_multiplier`;
- calculated quantity;
- current `order_link_id`;
- Bybit `order_id`, когда он известен;
- binding generation;
- current execution status;
- pending external action;
- early execution observation;
- history предыдущих exchange bindings.

Это не Runtime state и не копия Strategy Engine state.

> Correlation state отвечает на вопрос: **какое exchange execution ABI уже начал, выполнил или подтвердил для этой Runtime-owned пары?**

---

## Execution statuses

Внутренние statuses удобно рассматривать по смысловым группам.

### Current / in-progress binding

```text
pending_create
applied
pending_replace
pending_cancel
```

`applied` означает, что текущий entry package подтверждён ABI.

При этом `applied` **не доказывает наличие открытой позиции** — entry order может ещё не исполниться. Факт позиции определяется отдельно через open-position resolution.

`pending_*` фиксируют durable состояние операции, которая начата, но ещё не получила окончательно подтверждённый результат.

### Uncertain / failed execution state

```text
create_failed
unknown
```

Такое состояние нельзя автоматически интерпретировать как «ничего нет на бирже».

ABI должен fail closed и использовать confirmation/recovery semantics, а не угадывать exchange truth.

### Durably no exposure

```text
absent
terminal_unfilled
```

Эти состояния durable-доказывают отсутствие binding, который ещё способен создать позицию.

Поэтому open-position resolution может вернуть closed без лишнего live exchange query.

### Permanently closed cycle

```text
terminal_closed
```

Это отдельная более сильная семантика.

Она означает, что Runtime явно запросил завершение trade cycle и ABI подтвердил:

```text
position = 0
AND
attributed entry order is terminal
```

Такой trade cycle нельзя воскресить последующим entry-package PUT.

---

## Binding generation and history

Один trade cycle может иметь несколько последовательных exchange bindings.

Например:

```text
generation 1
    |
    | replace requiring new order
    v
generation 2
    |
    v
generation 3
```

ABI хранит current binding отдельно от `binding_history`.

Для каждого завершённого binding сохраняются его:

- `order_link_id`;
- `order_id`;
- generation;
- exchange symbol/category;
- время начала и окончания;
- причина завершения.

Это позволяет после restart восстановить связь старых exchange identities с той же Runtime-owned парой.

---

# Physical position scope

Кроме pair-level identity существует physical exchange scope:

```text
exchange category + exchange symbol
```

Например:

```text
linear:BTCUSDT
```

ABI не разрешает двум активным Runtime trade-cycle pairs одновременно владеть одним и тем же physical scope.

```text
(strategy A, cycle 1)
         |
         v
   linear:BTCUSDT
         ^
         |
(strategy B, cycle 9)
```

Если первый pair уже владеет scope и не доказан как durably closed, второй pair fail-closed не получает право создать новый binding.

Для этого используются:

- отдельный scope-level keyed mutex при acquisition;
- durable correlation write;
- reconstructed scope ownership после startup replay.

Scope освобождается только вследствие durable состояния, доказывающего отсутствие дальнейшего exposure.

---

# Concurrency model

Есть два разных уровня process-local synchronization.

### Pair mutex

Ключ:

```text
strategy_instance_id + trade_cycle_id
```

Один и тот же mutex registry используется execution services для сериализации конфликтующих операций одной пары.

Например, entry-package replace и close одного trade cycle не должны одновременно изменять один и тот же execution lifecycle.

### Scope mutex

Ключ:

```text
exchange category + exchange symbol
```

Он используется только при acquisition physical scope между разными pairs.

Lock ordering фиксирован:

```text
pair lock
   |
   v
scope lock
```

Обратного acquisition path нет.

### Durable file writes

Correlation repository отдельно сериализует physical append operations к одному JSONL-файлу.

Эти механизмы являются **process-local**. Текущий ABI V1 не предоставляет distributed lock/CAS для coordination нескольких одновременно работающих replicas.

---

# Startup replay and readiness

При startup ABI восстанавливает correlation state из durable JSONL.

```text
process start
    |
    v
load config
    |
    v
start HTTP server
    |
    v
correlation replay
    |
    +---------------------+
    |                     |
  success               failure
    |                     |
    v                     v
entryPackageReady=true   entryPackageReady=false
    |                     |
    v                     v
Runtime execution        Runtime execution
routes admitted          routes blocked
```

Replay восстанавливает:

- latest record для каждой `(strategy_instance_id, trade_cycle_id)`;
- indexes по `order_link_id`;
- indexes по Bybit `order_id`;
- current physical-scope ownership.

Replay работает fail-closed.

Невалидная non-final JSONL запись, structurally invalid record или конфликт durable scope ownership блокируют readiness.

Последний оборванный tail record может быть проигнорирован как возможный crash во время append.

`GET /health` отражает эту execution readiness:

- `200` при `entryPackageReady=true`;
- `503` при `entryPackageReady=false`.

Следовательно, поднятый HTTP process сам по себе ещё не означает готовность ABI принимать Runtime execution commands.

---

# Execution safety

ABI имеет несколько независимых safety gates.

Для live Bybit write одновременно должны выполняться условия:

```text
ABI_DRY_RUN=false
AND
ABI_LIVE_TRADING_ENABLED=true
AND
BYBIT_API_KEY configured
AND
BYBIT_API_SECRET configured
AND
BYBIT_ENV is demo or testnet
```

Mainnet live execution в текущем контуре запрещён guard-ом.

Safe defaults:

```text
ABI_DRY_RUN=true
ABI_LIVE_TRADING_ENABLED=false
BYBIT_ENV=testnet
```

Explicit invalid runtime configuration fail-fast ломает startup вместо silent fallback.

В частности fail-closed разбираются:

- boolean flags;
- `BYBIT_ENV`;
- HTTP port;
- timeout/cache numeric settings;
- пустые explicit string settings там, где используется non-empty configuration.

Отсутствующее значение может использовать documented default. Явно присутствующее невалидное значение не превращается молча в default.

---

# Confirmation model

ABI отделяет:

```text
write accepted by Bybit
```

от:

```text
desired exchange state confirmed
```

Для entry package используются fresh realtime/history reads.

Protection подтверждается fresh position read-back.

Close подтверждает и zero position, и terminality attributed entry order.

Некоторые confirmation paths выполняют небольшое bounded количество fresh re-reads с фиксированной задержкой.

Это **не общий retry/recovery daemon**:

- ABI не имеет бесконечного background retry loop;
- transport failure не превращается автоматически в success;
- ambiguous result fail-closed;
- durable pending/correlation state сохраняет контекст, необходимый для повторной команды или startup replay.

---

# Responsibility ownership

| Concern | Owner |
|---|---|
| market data / candles | Market Data Service |
| strategy calculations | Strategy Engine |
| live trade-cycle lifecycle | Strategy Runtime |
| desired entry / protection / close decision | Strategy Runtime / Strategy Engine |
| exchange instrument resolution | ABI |
| current trading rules | ABI / Bybit |
| V1 executable quantity | ABI |
| Bybit request mapping | ABI |
| exchange order execution | ABI |
| exchange position truth | Bybit, resolved through ABI |
| ABI execution correlation | ABI |
| confirmed management state | Strategy Runtime |
| physical-scope exclusivity inside ABI process | ABI |

---

# HTTP surface

## Strategy Runtime → ABI

Основной machine-to-machine surface:

```text
PUT    /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/entry-package
GET    /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position
PUT    /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/protection
DELETE /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position
```

| Operation | Meaning |
|---|---|
| `PUT .../entry-package` | apply, replace or cancel desired entry package |
| `GET .../open-position` | resolve current position truth for the pair |
| `PUT .../protection` | apply and confirm current stop/take protection |
| `DELETE .../open-position` | close and terminalize the trade cycle |

Полные wire schemas здесь не дублируются. Актуальные OpenAPI documents находятся в [`docs/openapi/`](docs/openapi/), behavioral authority — в [`openspec/specs/`](openspec/specs/).

---

## Operational endpoints

```text
GET /health
GET /execution/mode
```

`/health` показывает execution readiness.

`/execution/mode` показывает effective safety state, включая:

- dry-run;
- live enable flag;
- Bybit environment;
- наличие credentials;
- `canExecuteLive`;
- причины блокировки live execution.

---

## Operator / account surface

ABI также содержит отдельные operator/account endpoints:

```text
GET  /account/balance
GET  /account/orders/active
GET  /account/positions/open

POST /account/orders/cancel-all
POST /account/positions/close-all
```

Это не основной Strategy Runtime contract.

Read operations используются для account inspection. Emergency write operations проходят через тот же live-execution guard и не являются частью обычного strategy lifecycle.

---

# V1 operational boundaries

Текущий ABI следует нескольким сознательным V1 ограничениям.

### Position lifecycle scope

Live open-position / protection / close lifecycle сейчас рассчитан на поддерживаемый Bybit `linear` position scope.

Unsupported exchange scope fail-closed не притворяется успешно обработанной позицией.

### Position attribution

Live Bybit position query адресуется по exchange category + symbol.

Биржа не возвращает Runtime `strategy_instance_id` или `trade_cycle_id` вместе с общей symbol-level position.

Поэтому V1 предполагает отсутствие параллельного manual или внешнего strategy exposure на том же physical account/symbol, которое ABI не может отличить от своей позиции только по Bybit position row.

ABI physical-scope exclusivity предотвращает конфликт между собственными active Runtime pairs, но не способен доказать происхождение сторонней ручной позиции.

### One process coordination

Pair/scope mutexes находятся в памяти процесса.

Current container topology предполагает один ABI process. Distributed multi-replica coordination текущим V1 не заявляется.

### No strategy responsibility

ABI никогда не должен самостоятельно решать:

- нужен ли entry;
- какая сторона предпочтительнее;
- каким должен быть stop/take;
- когда закрывать позицию по стратегии.

Если Runtime не прислал соответствующий command, ABI не придумывает его самостоятельно.

---

# Configuration

Configuration читается из environment.

Основные variables:

| Variable | Default | Meaning |
|---|---:|---|
| `ABI_HOST` | `127.0.0.1` | HTTP bind host |
| `ABI_PORT` | `8787` | HTTP port |
| `ABI_DRY_RUN` | `true` | блокирует live writes |
| `ABI_LIVE_TRADING_ENABLED` | `false` | отдельное explicit разрешение live writes |
| `ABI_ENTRY_PACKAGE_CORRELATION_PATH` | `./var/abi_entry_package_correlation.jsonl` | durable correlation store |
| `ABI_INSTRUMENT_RULES_CACHE_TTL_MS` | `300000` | trading-rules cache TTL |
| `ABI_BYBIT_REQUEST_TIMEOUT_MS` | `10000` | Bybit request timeout |
| `BYBIT_ENV` | see below | `demo`, `testnet` or `mainnet` |
| `BYBIT_API_KEY` | empty | Bybit API key |
| `BYBIT_API_SECRET` | empty | Bybit API secret |
| `BYBIT_ACCOUNT_TYPE` | `UNIFIED` | Bybit account type |
| `BYBIT_RECV_WINDOW` | `5000` | signed request receive window |
| `BYBIT_CATEGORY` | `linear` | default category for paths that use global config |
| `BYBIT_SETTLE_COIN` | `USDT` | settle coin |
| `BYBIT_TRIGGER_BY` | `LastPrice` | trigger source |

`BYBIT_ENV` — preferred explicit environment selector.

Допустимые значения:

```text
demo
testnet
mainnet
```

Если `BYBIT_ENV` отсутствует, сохраняется backward-compatible fallback через `BYBIT_TESTNET`; при отсутствии обоих effective environment становится `testnet`.

Непустые string configuration values нормализуются там, где это предусмотрено (`upper/lower case`), но это не означает, что config layer выполняет полную semantic validation каждого возможного Bybit enum. Exchange/API validation остаётся отдельной границей.

---

# Local development

Для локальной разработки нужен Node.js 20+.

Установить зависимости:

```bash
npm ci
```

Запустить tests:

```bash
npm test
```

Typecheck:

```bash
npm run typecheck
```

Build:

```bash
npm run build
```

Запуск compiled service:

```bash
npm start
```

Без explicit environment service использует safe local defaults и bind:

```text
127.0.0.1:8787
```

Проверить состояние:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/execution/mode
```

---

# Docker

Репозиторий содержит standalone Docker path для ABI.

Это контейнеризация самого ABI service, а не общий Compose всего BBB stack.

Запуск safe container:

```bash
docker compose up --build
```

Текущий Compose:

- публикует ABI на `127.0.0.1:8787`;
- внутри container явно задаёт `ABI_HOST=0.0.0.0`;
- использует `ABI_DRY_RUN=true`;
- использует `ABI_LIVE_TRADING_ENABLED=false`;
- использует `BYBIT_ENV=testnet`;
- не требует Bybit credentials для safe startup;
- монтирует `./var:/app/var`;
- использует `/health` для container healthcheck.

Проверить:

```bash
docker compose ps
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/execution/mode
```

Логи — каждая строка это один structured JSON object (`timestamp`/`level`/`service`/`event` plus event-specific fields), не free-text:

```bash
docker compose logs -f abi
```

Остановить:

```bash
docker compose stop
```

Production container запускает Node напрямую как PID 1, под dedicated non-root user (`node`, uid/gid 1000 — встроенный в базовый образ `node:20-bookworm-slim`).

При `SIGTERM` / `SIGINT` ABI:

```text
stops accepting new HTTP connections
        |
        v
closes HTTP server
        |
        v
exits through normal shutdown path
```

Correlation state остаётся в host-mounted `./var` и не является частью image layer. Container process работает под non-root `node` (uid/gid 1000), поэтому host-каталог `./var` должен быть writable этим uid/gid.

На Linux host с обычным bind mount это может потребовать явного ownership:

```bash
mkdir -p var
chown 1000:1000 var
```

На Docker Desktop (macOS/Windows) bind-mount ownership проходит через virtualization/file-sharing layer, и predварительный numeric `chown` обычно не требуется — используй его только если реально столкнулся с permission error при первом запуске.

Для explicit demo workflow используется отдельный Compose override и local environment file; operational details находятся в [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

---

# Verification

Основной local verification:

```bash
npm test
npm run typecheck
npm run build
npm run validate:openapi
openspec validate --strict --all
git diff --check
```

Entry-package fake smoke:

```bash
npm run smoke:entry-package:fake
```

Read-only Bybit smoke commands также существуют отдельно; условия их запуска и credentials описаны в [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

---

# Repository orientation

```text
src/
├── app/
├── routes/
├── services/
├── domain/
├── correlation/
├── concurrency/
├── exchange/
├── execution/
├── risk/
└── account/
```

Основные области:

| Path | Responsibility |
|---|---|
| `src/app` | composition root, HTTP server, readiness, graceful shutdown |
| `src/routes` | thin HTTP transport boundaries |
| `src/services/entryPackage` | entry-package orchestration and confirmation |
| `src/services/openPosition` | current position determination |
| `src/services/protection` | protection execution/read-back |
| `src/services/close` | position close and terminalization |
| `src/domain` | transport/domain contracts and exact-decimal primitives |
| `src/correlation` | durable execution records, indexes, replay |
| `src/concurrency` | keyed process-local synchronization |
| `src/exchange` | Bybit adapter, instrument resolution, trading rules, payload mapping |
| `src/execution` | guarded exchange write operations |
| `src/risk` | V1 executable quantity calculation |
| `src/account` | operator/account helpers |
| `test` | behavior, contract and regression tests |
| `docs/openapi` | HTTP wire schemas |
| `openspec/specs` | canonical behavioral requirements |

---

# Sources of truth

README нужен как карта сервиса, а не как дубликат всех контрактов.

При расхождении:

1. canonical behavioral requirements — [`openspec/specs/`](openspec/specs/);
2. HTTP wire contracts — [`docs/openapi/`](docs/openapi/);
3. executable behavior — production code + tests;
4. operational procedures — [`docs/RUNBOOK.md`](docs/RUNBOOK.md);
5. deeper architecture description — [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

# Related documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — более подробная архитектура и execution components.
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — запуск, Docker, credentials и operational smoke.
- [`docs/openapi/`](docs/openapi/) — Runtime-facing HTTP contracts.
- [`openspec/specs/`](openspec/specs/) — canonical behavioral specifications.