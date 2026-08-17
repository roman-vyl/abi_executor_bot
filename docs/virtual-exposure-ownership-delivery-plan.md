# Мастер-план: от position-scope-exclusivity к virtual same-side exposure ownership

> Это мастер-план последовательности будущих OpenSpec changes (GitHub Issue #3: "Backlog: virtual
> position ledger for shared same-symbol exposure"). Сам план не является OpenSpec change и ничего не
> реализует — каждый пункт раздела 2 должен быть оформлен как отдельный OpenSpec change (proposal/
> design/tasks) со своим review и apply.

> **Ревизия v2 по итогам review.** Внесены четыре исправления: (1) единое поле `owned_quantity`
> разделено на immutable `filled_quantity` и mutable `remaining_quantity`; (2) исправлена фактическая
> ошибка — `GET .../open-position` НЕ возвращает quantity/size на wire-уровне (проверено по
> `src/domain/openPositionApi.ts:4-14`), per-cycle quantity остаётся строго внутренней; (3) бывший
> Change 6 (protection redesign) разделён на три отдельных change — state-foundation / execution /
> close-cleanup; (4) `average_entry_price`/`first_fill_at_ms` подняты в Change 1 с той же строгостью
> sourcing, что и quantity — это и есть настоящий virtual exposure state, "ownership" scope — понятие
> производное. Итоговая программа — 8 changes вместо 6.

## Контекст

Сегодня `abi_executor_bot` (ABI) реализует **position-scope-exclusivity**: один физический Bybit-scope
(`account` + `category` + `symbol`, всегда one-way `positionIdx=0`) может принадлежать не более чем одному
`(strategy_instance_id, trade_cycle_id)` одновременно. Инвариант закреплён в
`openspec/specs/position-scope-exclusivity/spec.md:11-14` и реализован единственной точкой входа —
атомарным claim в `EntryPackageApplicationService.createOrder()`
(`src/services/entryPackage/entryPackageApplicationService.ts:268-294`) поверх производного индекса
`byScope` в `EntryPackageCorrelationRepository` (`src/correlation/entryPackageCorrelationRepository.ts:120-257`).
Это был осознанный V1-бордер: сам код (`src/domain/positionScope.ts:1-14`) и минимум четыре архивных
change (`2026-08-07-abi-position-scope-exclusivity-v1`, `...-close-execution-v1`, `...-protection-execution-v1`)
явно откладывают "shared ownership одного physical scope несколькими trade cycles" на внешний backlog —
**GitHub Issue #3 "Backlog: virtual position ledger for shared same-symbol exposure"**. Design/спека для
этого issue в репозитории никогда не было — только повторяющаяся ссылка-заглушка.

Цель этого документа: подготовить **последовательность будущих OpenSpec changes**, реализующих это issue
в контролируемом виде — без единого "большого" change, без изменения Strategy Runtime и MDS, с сохранением
уже работающей mutex/durability инфраструктуры где возможно.

### Ключевые находки, которые определяют архитектуру

1. **Где хранится текущая scope ownership** — не отдельное хранилище, а *производный* индекс поверх
   `EntryPackageExecutionRecord` (JSONL append-only, replay в память при старте,
   `src/correlation/entryPackageExecutionRecord.ts:75-104`). `byScope: Map<"category:symbol", record>`
   — единственный владелец на scope. Это прямо указывает путь эволюции: не заводить новый durable store,
   а расширить существующую запись и производный индекс (см. Change 1).

2. **`OpenPositionResolutionService.determine()`** (`src/services/openPosition/openPositionResolutionService.ts:101-140`)
   уже сегодня явно документирует дыру атрибуции (строки 53-63): live Bybit-запрос скоупится только по
   `category+symbol`, "not proof of attribution", корректность держится на внешнем допущении "no overlapping
   exposure". Более того, `average_entry_price`/`first_fill_at_ms` берутся **напрямую** из агрегированной
   Bybit-позиции (spec L193-199, "never estimated") — этот инвариант физически несовместим с shared-position:
   если позицию физически делят два cycle, у Bybit есть только ОДНА агрегированная `avgPrice`, а не по одной
   на cycle. Это неизбежная точка разрыва инварианта, независимо от того, как строить virtual ledger. **Wire-
   контракт при этом не меняется**: `OpenPositionSuccessResponse` (`src/domain/openPositionApi.ts:4-14`)
   содержит только `position_open` / `first_fill_at_ms` / `average_entry_price` — никакого `size`/quantity
   поля в ответе нет и не появляется; per-cycle quantity нужна ABI исключительно внутри (для close и,
   позже, для sizing protection-ордеров).

3. **`CloseApplicationService`** (`src/services/close/closeApplicationService.ts:153-179`) закрывает **весь**
   `row.size` живой Bybit-позиции market/reduceOnly ордером — специально **не** доверяя ABI-шным
   calculated/recorded количествам (close-execution spec L110-124 прямо запрещает это как источник qty).
   Переход на pair-scoped close по virtual-quantity — это осознанный **разворот** этой философии
   "trust only live exchange state", и он оправдан только тем, что Bybit физически не может сказать
   "закрой только долю cycle X" — эту долю обязана знать сама ABI.

4. **`ProtectionApplicationService`** использует `/v5/position/trading-stop` — это **position-level, full-state
   replace** для всей физической позиции (`tpslMode: "Full"`, `positionIdx: 0`,
   `src/exchange/bybitAdapter.ts:257-271`). У этого API физически нет способа независимо обслуживать
   несколько trade cycles одного symbol — значит текущий protection-execution обязан быть либо
   переосмыслен (pair-owned reduce-only conditional orders), либо временно заблокирован для shared-scope,
   пока не переосмыслен.

5. **Concurrency сегодня уже дружелюбна к multi-owner**: mutex-гранулярность — `(strategy_instance_id,
   trade_cycle_id)` пара (`src/concurrency/keyedMutex.ts`, используется одним и тем же instance во всех
   трёх application services — `src/app/server.ts:47,69,80`), а не per-scope. Scope-level mutex
   (`scopeMutex`) используется только транзиently, только в момент claim, никогда не держится через
   Bybit-вызов. Значит per-pair сериализация НЕ требует изменений — меняется только семантика самого
   scope-claim.

6. **Order identity уже cycle-scoped**: `orderLinkId = abi-ep-{sha256(strategyInstanceId, tradeCycleId,
   role, generation)}` (`src/domain/entryPackageOrderIdentity.ts:8-20`). Это готовый паттерн для будущих
   pair-owned protection-ордеров (roles `"stop"`/`"take"` вместо `"entry"`), не требующий изобретения новой
   схемы идентичности.

7. **Recovery** (`EntryCycleRecoveryResolutionService`) сегодня подтверждает `position_open` через пару
   (order query по своему orderLinkId) + (aggregate position query, сверка по side). При shared scope
   side-match перестаёт доказывать "это моя позиция" — он совпадёт и у cycle-соседа. Это отдельная,
   хоть и небольшая, точка разрыва.

### Архитектурное решение: где живёт virtual exposure state

**Не заводим новый durable store.** Расширяем `EntryPackageExecutionRecord` набором additive-полей,
образующих единую сущность **per-cycle virtual exposure fact** (не "ownership" — владение scope это
производное понятие, см. ниже):

- `physical_side: "long" | "short" | null` — сторона этого cycle, из `desired_entry.side`.
- `filled_quantity: string | null` — **immutable** исторический факт: сколько реально исполнилось на
  **собственном ордере** этого cycle. Заполняется один раз на confirmation-шаге, из данных этого же
  ордера (той же query, что уже используется confirmation-логикой), никогда не мутируется после
  установки. Не путать с `calculated_quantity` (это желаемое qty на входе, уже существующее поле).
- `remaining_quantity: string | null` — **mutable**, стартует равным `filled_quantity`, уменьшается
  ровно один раз до `0` при durable close этого cycle (partial-close **своей** доли в эту программу не
  входит — переход только "полное владение → 0"). Держим отдельно от `filled_quantity`, чтобы (a) close
  никогда не трогал исторический факт входа, (b) `sum(remaining_quantity активных owners)` был прямой
  проверяемой drift-инвариантой против live aggregate size, (c) остался чистый шов для гипотетического
  будущего partial-close без повторной миграции схемы.
- `average_entry_price: string | null`, `first_fill_at_ms: number | null` — тот же класс immutable
  исторических фактов, что `filled_quantity`, **с той же строгостью sourcing**: из данных собственного
  ордера этого cycle, не из агрегированной Bybit-позиции. Это прямая замена сегодняшнего "sourced
  directly from the live aggregate row, never estimated" (open-position-resolution spec L193-199) —
  после появления shared scope агрегированная `avgPrice` перестаёт быть per-cycle истиной в принципе.

Эти пять полей **и есть** virtual exposure state — не вспомогательная деталь claim-логики. `byScope`
эволюционирует из `Map<scope, record>` в `Map<scope, {side, owners: Map<pairKey, VirtualExposure>}>`, где
`VirtualExposure` — тип, живущий **на записи** (its identity IS the correlation record), а не отдельная
сущность рядом с ней. "Ownership" scope (Change 5) — это производное понятие поверх множества активных
`VirtualExposure` одной стороны, не параллельная модель данных.

Это прямое продолжение уже сформулированного в спеке принципа "scope ownership derived from existing
durable correlation state, not a new store" (position-scope-exclusivity spec L35-46). Отдельный "ledger"
как самостоятельный источник истины не нужен и добавил бы второй source of truth без выгоды.

### Архитектурное решение: protection

Сравнены два варианта:

- **A. Position-level protection с виртуальной координацией** (агрегированный/усреднённый stop-take на
  всю физическую позицию). Отклонён: физически невозможно честно обслужить два разных желаемых
  stop/take одновременно через один `/v5/position/trading-stop`; закрытие одного cycle требует
  пересчитывать/переотправлять общий stop для оставшихся; нарушает уже существующий инвариант
  "exact numeric match to accepted values" per pair (protection-execution spec L75-119).
- **B. Pair-owned reduce-only conditional exit orders** (собственный stop-order и take-order на cycle,
  reduceOnly, qty = `remaining_quantity`, orderLinkId по уже существующей схеме
  `entryPackageOrderIdentity.ts`). Выбран как архитектурно верный — единственный вариант с честной
  per-cycle изоляцией, переиспользует уже отработанные паттерны (order identity, bounded confirmation,
  reduceOnly semantics, которые уже использует close-execution).

Вариант B реализуется не одним, а **тремя** отдельными changes (6, 7, 8 — см. ниже): отдельно data model/
identity/adapter-примитивы (foundation, без изменения поведения), отдельно сам execution-lifecycle
(create/replace/cancel/confirm + снятие guard), отдельно интеграция с close (cancellation своих
protection-ордеров при закрытии cycle). Это то же разделение foundation/activation, что уже применено к
базовой ownership-цепочке (Changes 1 → 5) — исходная версия плана содержала это разделение для ownership,
но не для protection; после review это несогласованность устранена.

### Нужен ли отдельный "foundation" change до изменения execution semantics?

**Да, дважды** — не только для базовой ownership-цепочки (Change 1), но и для protection (Change 6).
Оба раза принцип один: сначала эволюция данных/идентичности (без изменения наблюдаемого поведения,
тестируется независимо), потом изменение бизнес-политики/execution поверх уже стабильного фундамента.

### Ключевой сиквенс-инсайт (важно для порядка ниже)

Нельзя просто "разрешить второму cycle присоединиться к scope" (activation) раньше, чем close/open-position/
recovery станут owner-aware — иначе в первый же момент реального multi-owner состояния close снесёт
**всю** физическую позицию (включая долю соседнего cycle), а protection одного cycle начнёт незаметно
управлять экспозицией другого. Поэтому план **готовит** consumers (close, open-position, recovery) к
multi-owner заранее — их новая ветка логики тестируется на **синтетически подготовленных** multi-owner
фикстурах (репозиторий это позволяет без изменения claim-политики), пока производственная claim-политика
всё ещё эксклюзивна. Реальная активация (разрешение второго owner) становится последним, самым маленьким
и самым безопасным шагом среди "базовых" changes.

---

## 1. Итог целевой архитектуры

- Physical scope (`account+category+symbol+positionIdx=0`) может иметь несколько активных owners
  (`strategy_instance_id, trade_cycle_id`), но только **одной стороны** одновременно: long+long и
  short+short разрешены, long+short — запрещён, пока жива хоть одна exposure противоположной стороны.
- Virtual exposure state — пять additive-полей на существующем `EntryPackageExecutionRecord`
  (`physical_side`, `filled_quantity`, `remaining_quantity`, `average_entry_price`, `first_fill_at_ms`) +
  производный многовладельческий scope-индекс. Никакого нового durable store.
- `open-position` для конкретного cycle отвечает исходя из **собственных** `average_entry_price`/
  `first_fill_at_ms` этого cycle (из данных его собственного ордера), а не из агрегированной
  Bybit-позиции — агрегированный live-запрос остаётся только как sanity-проверка существования/стороны.
  **Wire-контракт не меняется и не расширяется quantity-полем** — quantity остаётся внутренним понятием.
- `close` для конкретного cycle уменьшает физическую позицию ровно на `remaining_quantity` этого cycle
  (reduceOnly), а не закрывает весь physical size — при единственном владельце поведение идентично
  сегодняшнему (используется live aggregate size, как раньше, для устранения дрейфа).
- `protection` до отдельных redesign-changes явно блокируется (fail closed) для scope с >1 активным
  owner; сам redesign (в три этапа — foundation/execution/close-cleanup) переводит protection на
  pair-owned reduceOnly conditional stop/take-ордера с собственными orderLinkId на cycle.
- Recovery перестаёт полагаться на side-match агрегированной позиции как на доказательство "моя
  позиция" — авторитетным становится статус **собственного** ордера cycle.
- Публичные HTTP-контракты (`PUT entry-package`, `GET open-position`, `PUT protection`,
  `DELETE open-position`) **не меняются по форме** — меняется только семантика ("full remainder" теперь
  означает "весь остаток именно этого cycle", а не физической позиции). Текстовые правки нужны только
  в prose двух OpenAPI-специй (`abi-position-management-api`, `abi-open-position-lookup-api`).

---

## 2. Упорядоченная последовательность changes

| № | change-id | Capability(ies) | Тип |
|---|---|---|---|
| 1 | `abi-virtual-exposure-state-foundation-v1` | новая: virtual-exposure-state (+ additive к entry-package-execution) | Data model, без изменения поведения |
| 2 | `abi-pair-scoped-close-execution-v1` | `close-execution` | Consumer prep (owner-aware, ветвление) |
| 3 | `abi-pair-scoped-open-position-resolution-v1` | `open-position-resolution` | Consumer prep (owner-aware, wire-контракт без изменений) |
| 4 | `abi-entry-cycle-recovery-attribution-v1` | `entry-cycle-recovery-resolution` | Consumer prep (owner-aware) |
| 5 | `abi-same-side-virtual-exposure-ownership-v1` | супersedes `position-scope-exclusivity`; малый guard в `protection-execution` | **Activation** — центральный change |
| 6 | `abi-pair-owned-protection-state-foundation-v1` | новая: pair-owned protection identity/state (+ additive к `protection-execution`) | Data model/identity, без изменения поведения |
| 7 | `abi-pair-owned-protection-execution-v1` | `protection-execution` | Execution redesign (снимает guard из Change 5) |
| 8 | `abi-pair-owned-protection-close-cleanup-v1` | `close-execution` (расширение) | Close/protection integration |

Changes 2, 3, 4 формально зависят только от Change 1 и **не зависят друг от друга** — их можно вести
параллельно/в любом порядке. Change 8 можно слить с Change 7, если после детального scoping Change 6/7
окажется, что cancellation-логика тривиальна — решение принимается по факту, не заранее (см. Change 8).
Ниже дан рекомендованный линейный порядок для одной команды.

---

## 3. Детали по каждому change

### Change 1 — `abi-virtual-exposure-state-foundation-v1`

**Цель.** Дать данным способность представлять нескольких owners одного physical scope одной стороны —
через полноценную per-cycle virtual exposure fact, а не через одно перегруженное поле — не меняя ничьё
наблюдаемое поведение.

**Что меняется.**
- `EntryPackageExecutionRecord` (`src/correlation/entryPackageExecutionRecord.ts`): пять новых
  additive-полей:
  - `physical_side: "long" | "short" | null` — заполняется при первом бинде, из `desired_entry.side`.
  - `filled_quantity: string | null` — immutable, устанавливается один раз на confirmation-шаге из
    данных собственного ордера этого cycle (исполненное qty именно этого ордера — конкретное поле в
    Bybit-ответе, `cumExecQty`/аналог, требует технического подтверждения, см. риски). Никогда не
    переписывается после установки.
  - `remaining_quantity: string | null` — mutable, инициализируется равным `filled_quantity` в момент
    его установки, уменьшается **только** при durable close этого cycle (в этой программе — переход
    ровно в `0`, partial-close своей доли не вводится).
  - `average_entry_price: string | null`, `first_fill_at_ms: number | null` — immutable, та же
    confirmation-точка и тот же источник (собственный ордер cycle), что `filled_quantity`. Требуют того
    же технического подтверждения источника в Bybit-ответе.
- `EntryPackageCorrelationRepository`: `byScope` эволюционирует из `Map<scopeKey, record>` в
  `Map<scopeKey, { side; owners: Map<pairKey, VirtualExposure> }>`, где `VirtualExposure` — проекция
  вышеуказанных пяти полей записи (не отдельно хранимая сущность). `applyScopeClaimOnWrite` и
  `rebuildScopeIndexFromReplay` (`entryPackageCorrelationRepository.ts:179-257`) переписываются под
  новую форму, но вызывающий код (claim-check в entry-package) продолжает получать поведенчески то же
  самое — "один активный owner на scope" (политика не меняется, меняется только представление).
  Существующий `findOwnerByScope()` сохраняется как совместимая обёртка; добавляется новый
  `findOwnersByScope()` для будущих потребителей.
- Новый тип `src/domain/virtualExposure.ts` — `VirtualExposure` (side + filled_quantity +
  remaining_quantity + average_entry_price + first_fill_at_ms), явно документированный как "identity —
  сама correlation-запись, не отдельная сущность".

**Какие инварианты отменяются.** Ни один поведенческий инвариант не отменяется — только внутреннее
представление данных (`byScope` меняет форму с "один владелец" на "структура, способная хранить многих").

**Новые инварианты.**
- `filled_quantity`/`average_entry_price`/`first_fill_at_ms` immutable после установки — попытка
  повторной записи другим значением является программной ошибкой, а не легитимным обновлением.
- `remaining_quantity` меняется ровно один раз за жизнь записи (`filled_quantity` → `0`), только через
  durable close.
- Производный индекс восстанавливается из replay детерминированно для N совладельцев одной стороны
  (расширение существующей "two-phase replay, judged on final state only").
- Смешанная сторона в финальном replay-состоянии одного scope — по-прежнему hard-fail readiness (это
  генуинный сигнал повреждения данных).

**Затрагиваемые слои.** `src/correlation/entryPackageExecutionRecord.ts`,
`src/correlation/entryPackageCorrelationRepository.ts`, `src/domain/virtualExposure.ts` (новый). Не
затрагивает `services/close`, `services/openPosition`, `services/protection`, `services/entryPackage`
(claim-логика не меняется — расширяется только позже).

**HTTP-контракты.** Не меняются.

**Обязательные тесты.**
- Replay восстанавливает multi-owner структуру из **синтетически подготовленных** (сидированных
  напрямую в JSONL/через тестовый API репозитория) записей с одной стороной — до Change 5 production-код
  никогда сам такую ситуацию не создаст, поэтому тест обязан строить её напрямую.
- `filled_quantity`/`average_entry_price`/`first_fill_at_ms` действительно immutable — попытка второй
  записи другим значением фейлится/не допускается на уровне репозитория.
- `remaining_quantity` инициализируется равным `filled_quantity` и переходит в `0` только через явный
  close-путь (тестируется на уровне репозитория напрямую, до появления Change 2).
- Backward-compat: replay старых записей без новых полей (default/derive без падения).
- Все существующие тесты `entryPackageCorrelationRepository.test.ts` проходят без изменений
  наблюдаемого поведения.
- Mixed-side replay всё ещё fail-closed.

**Зависит от.** Ничего (первый шаг).

**Состояние после.** Данные готовы представлять multi-owner через полноценную per-cycle exposure fact;
поведение системы идентично сегодняшнему; `position-scope-exclusivity` продолжает управлять фактическим
поведением без изменений.

**Осознанно вне scope.** Любое изменение claim-политики, close, open-position, protection. Технический
spike точного маппинга Bybit order-response полей → `filled_quantity`/`average_entry_price`/
`first_fill_at_ms` должен быть закрыт **до** написания proposal (см. риск §6.1), но сам spike не
результат этого change, а его предпосылка.

---

### Change 2 — `abi-pair-scoped-close-execution-v1`

**Цель.** Реализовать архитектурную идею №3 — close конкретного cycle через pair quantity, а не через
закрытие всей физической позиции — заранее, безопасно, под ветвлением "если owner один — старое
поведение".

**Что меняется.** `CloseApplicationService` (`src/services/close/closeApplicationService.ts:153-179`):
- Если у scope ровно один активный owner — поведение **не меняется**: reduceOnly qty = live aggregate
  `row.size` (как сегодня, максимально доверяя exchange, не ABI-шным числам — сохраняем текущую
  философию "never trust ABI-recorded quantity" для этого случая).
- Если owners > 1 — reduceOnly qty = `remaining_quantity` этого cycle, **clamped** сверху живым остатком
  агрегированной позиции (защита от over-close/reject). Если `remaining_quantity` не заполнен/сумма
  `remaining_quantity` по всем активным owners заметно расходится с live aggregate size за пределами
  допуска — fail closed (см. риск о политике допуска дрейфа).
- Release-семантика уточняется: при durable close этого cycle `remaining_quantity` этой записи
  переводится в `0`, и запись убирается из `owners`-множества scope; сторона (`side`) scope очищается
  лишь когда множество owners становится пустым (сегодняшнее "release = весь scope" остаётся верным при
  единственном owner).

**Какие инварианты отменяются/заменяются.** close-execution spec L110-124 ("close size сурсится
исключительно из live aggregate query, никогда из ABI-recorded/calculated quantity") — заменяется на
"при единственном owner — как раньше; при множественном — обязательно из ABI-recorded
`remaining_quantity`, т.к. exchange физически не знает про доли между cycles". Это единственный
настоящий разворот философии в этой программе; квалифицируется отдельно как риск (см. §6).

**Новые инварианты.** "Close уменьшает физическую позицию ровно на долю closing cycle, оставляя чужие
доли нетронутыми"; "release из owner-множества не подразумевает release всего scope, пока есть другие
активные owners"; "close никогда не читает и не пишет `filled_quantity`/`average_entry_price`/
`first_fill_at_ms` — только `remaining_quantity`".

**Затрагиваемые слои.** `src/services/close/closeApplicationService.ts`,
`src/correlation/entryPackageCorrelationRepository.ts` (partial-release helper). Domain: возможно
`src/domain/positionScope.ts` для новых типов.

**HTTP-контракты.** `DELETE .../open-position` — форма (пустое тело, тот же response) не меняется.
Требуется **только текстовая** правка prose в `abi-position-management-api` spec ("full remainder"
уточняется как "remainder принадлежащий именно этому trade cycle").

**Обязательные тесты.**
- Single-owner: полностью регрессионные — поведение байт-в-байт как сегодня.
- Multi-owner (синтетические фикстуры, как в Change 1): close cycle A не отправляет reduceOnly qty
  больше `remaining_quantity`; cycle B остаётся `applied`/live и его владение scope сохраняется.
- Clamp-логика: `remaining_quantity` больше живого остатка → используется живой остаток, не превышение.
- Drift-за-пределами-допуска → fail closed, конкретный код ошибки.
- `filled_quantity`/`average_entry_price`/`first_fill_at_ms` этого cycle и соседних не изменяются в
  результате close.
- Existing `closeApplicationService.test.ts` регрессия — без изменений в assertions single-owner кейсов.

**Зависит от.** Change 1.

**Состояние после.** Close готов к multi-owner, но production не может создать multi-owner scope до
Change 5 — поведение в проде идентично сегодняшнему.

**Осознанно вне scope.** Отмена/cancel pair-owned protection-ордеров при close (это придёт в Change 8,
когда такие ордера появятся).

---

### Change 3 — `abi-pair-scoped-open-position-resolution-v1`

**Цель.** Архитектурная идея №2 — open-position pair-scoped на основе virtual exposure конкретного
trade cycle, а не агрегированной физической позиции. **Wire-контракт не меняется**: ответ
`GET .../open-position` по-прежнему содержит только `position_open`/`first_fill_at_ms`/
`average_entry_price` (`src/domain/openPositionApi.ts:4-14`) — никакой quantity/size-поле не
добавляется.

**Что меняется.** `OpenPositionResolutionService.determine()`
(`src/services/openPosition/openPositionResolutionService.ts:101-140`):
- `average_entry_price`/`first_fill_at_ms` для ответа этого cycle сурсятся из **собственных** одноимённых
  полей записи (заполненных в Change 1 из данных собственного ордера этого cycle), а не из агрегированной
  Bybit-позиции — инвариант spec L193-199 заменяется, см. ниже.
- Live-запрос агрегированной позиции (`queryPositionForInstrument`) сохраняется, но переопределяется
  как **sanity-check существования и стороны** ("aggregate exists, side matches, size ≥
  `remaining_quantity` этого cycle в пределах допуска"), а не как источник истины по цене/времени входа.
  `remaining_quantity`/`filled_quantity` используются здесь **только** для sanity-check, наружу в ответе
  не попадают.

**Какие инварианты отменяются/заменяются.**
- open-position-resolution spec L166-177 (side-match — "plausibility check, не proof of attribution")
  — сохраняется как sanity-слой, но перестаёт быть единственной проверкой.
- L193-199 ("avgPrice/first_fill sourced напрямую из live row, never estimated") — заменяется:
  при единственном owner источник фактически тот же (совпадает), при множественном — обязателен
  собственный источник per-cycle (записанный в Change 1), т.к. агрегированная Bybit-позиция физически не
  может отдать раздельные avgPrice на владельца.

**Новые инварианты.** "Ответ open-position для cycle отражает `average_entry_price`/`first_fill_at_ms`
именно этого cycle, независимо от того, сколько ещё активных cycles делят тот же physical scope. Ответ
никогда не содержит и не подразумевает per-cycle quantity — это исключительно внутреннее понятие."

**Затрагиваемые слои.** `src/services/openPosition/openPositionResolutionService.ts`. Не трогает
routes/DTO слой (`src/routes/openPositionRoutes.ts`, `src/domain/openPositionApi.ts`) — форма ответа
идентична, поле quantity туда не добавляется.

**HTTP-контракты.** `GET .../open-position` — схема ответа не меняется. Текстовая правка prose в
`abi-open-position-lookup-api` (пояснение, что `average_entry_price`/`first_fill_at_ms` относятся к доле
этого trade cycle).

**Обязательные тесты.**
- Single-owner регрессия: значения идентичны сегодняшним (aggregate == собственная доля).
- Multi-owner (синтетические фикстуры): два cycle одной стороны на одном scope получают **разные**
  корректные `average_entry_price`/`first_fill_at_ms`, соответствующие их собственным ордерам, а не общей
  агрегированной позиции.
- Response DTO-тест подтверждает отсутствие quantity-поля в сериализованном ответе (защита от будущего
  случайного расширения публичного контракта).
- Sanity-check срабатывает: если aggregate meaningfully не согласуется с суммой `remaining_quantity` —
  fail closed (internal_error либо новый код), не тихая деградация.

**Зависит от.** Change 1.

**Состояние после.** Open-position готов к multi-owner; в проде поведение идентично сегодняшнему до
Change 5.

**Осознанно вне scope.** Любое расширение wire-контракта `GET .../open-position` (quantity-поле туда не
добавляется ни в этом change, ни позже в рамках этой программы). Изменение error-таксономии
`abi-open-position-lookup-api` сверх уже существующей (кроме, возможно, нового кода на явный
drift-случай — решается как часть §6 рисков).

---

### Change 4 — `abi-entry-cycle-recovery-attribution-v1`

**Цель.** Восстановить корректность recovery-атрибуции для сценария, где side-match агрегированной
позиции больше не доказывает "это моя позиция".

**Что меняется.** `EntryCycleRecoveryResolutionService`
(`src/services/entryCycleRecovery/entryCycleRecoveryResolutionService.ts`): текущая dual-query логика
(order-query + aggregate-position-query, оба обязаны "положительно согласиться") пересматривается так,
чтобы **собственный ордер cycle** (по его orderLinkId, через `getOrderByLinkId`/`getOrderHistory`) был
авторитетным источником для "мой ли это fill", а aggregate position query становится вспомогательной
проверкой существования/согласованности стороны, а не со-равноправным источником корробарации.

**Какие инварианты отменяются/заменяются.** Часть логики `resolveRecoveryState()`
(entry-cycle-recovery-resolution spec, раздел про dual-query agreement, L82-167) — переформулируется:
"положительное согласие" больше не требует, чтобы aggregate position подтверждала именно эту сторону
эксклюзивно — она подтверждает только, что физическая позиция этой стороны действительно существует,
а факт fill конкретного cycle доказывается его собственным ордером.

**Новые инварианты.** "Recovery-атрибуция для конкретного cycle никогда не зависит от того, сколько
других cycles разделяют тот же physical scope."

**Затрагиваемые слои.** `src/services/entryCycleRecovery/entryCycleRecoveryResolutionService.ts`. Не
трогает HTTP-слой (`src/routes/entryCycleRecoveryRoutes.ts`).

**HTTP-контракты.** `GET .../recovery-state` — не меняется.

**Обязательные тесты.**
- Полная регрессия существующего `entryCycleRecoveryResolutionService.test.ts` (single-owner случаи
  без изменений).
- Multi-owner (синтетические фикстуры): recovery для cycle B не путает fill cycle A с собственным —
  если у B нет собственного fill-evidence, а aggregate position существует (это позиция A), B корректно
  резолвится в `entry_order_live`/`terminal_without_fill`, а не ложно в `position_open`.
- Legacy `pending_action` guard (L214-254 текущей спеки) продолжает работать без изменений.

**Зависит от.** Change 1. (Не зависит от Change 2/3 технически, но использует тот же принцип
"собственные данные ордера — авторитетны", что и Change 3 — рекомендуется вести после Change 3 для
согласованности подхода в review, не как жёсткая зависимость.)

**Состояние после.** Recovery готов к multi-owner; production-поведение не меняется до Change 5.

**Осознанно вне scope.** Любые изменения к самому entry-package retry/replace flow.

---

### Change 5 — `abi-same-side-virtual-exposure-ownership-v1` (центральный change — "активация")

**Цель.** Архитектурная идея №1 — заменить physical-scope exclusivity на virtual same-side exposure
ownership. Это единственный change, реально включающий multi-owner в production.

**Что меняется.**
- `EntryPackageApplicationService.createOrder()` (`entryPackageApplicationService.ts:268-294`): claim-
  проверка меняется с "owner существует и это не та же пара → conflict" на "у scope уже есть активная
  сторона, отличная от стороны этой команды → conflict; иначе — присоединиться как дополнительный owner
  этой стороны" (используя структуру из Change 1).
- Release generalized: durable close одного cycle убирает только его запись из owner-множества
  (реализовано в Change 2/1); сторона scope очищается, когда множество опустело.
- **Неразделимый safety-компаньон**: малый guard в `ProtectionApplicationService` — если у scope больше
  одного активного owner, `PUT .../protection` для любого из них **fail closed** (новый явный код,
  например `shared_scope_protection_unsupported`) до прихода Change 7. Это обязано ехать в этом же
  change, а не отдельно — иначе между активацией multi-owner и появлением guard существует опасное окно,
  где position-level protection одного cycle незаметно управляет чужой долей.
- Startup-readiness conflict detection: конфликт теперь = **смешанная сторона** в финальном
  replay-состоянии scope (не "больше одного владельца" само по себе).

**Какие инварианты отменяются/заменяются.** Центральный инвариант position-scope-exclusivity spec
L11-14 ("at most one trade cycle pair holds a scope") заменяется на "at most one **side** is active per
scope at a time; any number of pairs sharing that side may hold it concurrently." Это заменяет собой всю
capability `position-scope-exclusivity` — рекомендуется завести новую capability
(например `virtual-exposure-ownership`), а старую перевести в статус superseded (см. §5).

**Новые инварианты.**
- Детерминированность одновременного join (переиспользуется существующая atomicity `scopeMutex`,
  обобщённая с "claim if empty" на "join if side compatible").
- Opposite-side rejection, пока жива хоть одна exposure текущей стороны.
- Освобождённый (пустой) scope принимает claim любой стороны — без изменений от сегодняшнего.
- Protection для scope с >1 owner фейлится закрыто (временный инвариант, снимается Change 7).

**Затрагиваемые слои.** `src/services/entryPackage/entryPackageApplicationService.ts`,
`src/correlation/entryPackageCorrelationRepository.ts` (partial-release из Change 2 используется здесь
по-настоящему), `src/services/protection/protectionApplicationService.ts` (малый guard),
`openspec/specs/position-scope-exclusivity/` → новая capability.

**HTTP-контракты.** `PUT .../entry-package` — форма не меняется. Возможное **дополнение** словаря
ошибок `abi-entry-package-api`/`abi-position-management-api` новым явным кодом для opposite-side и
protection-guard случаев (см. риск §6 п.3 — решить, оставлять ли `internal_error` для совместимости или
вводить точные коды).

**Обязательные тесты.**
- Два cycle одной стороны на одном scope: оба claim успешны, сосуществуют.
- Opposite-side claim при активной exposure → conflict, без durable-записи, без exchange-вызова (как
  сегодня для same-pair conflict).
- Durable close одного cycle не влияет на другого (переиспользует тесты Change 2, теперь под реальной
  multi-owner активацией).
- Restart/replay реконструирует multi-owner scope корректно (реальные, не синтетические, записи).
- Mixed-side в финальном replay-состоянии — по-прежнему hard readiness failure.
- Protection guard: PUT protection на любой из двух active owners одного scope → fail closed с новым
  кодом; на единственном owner — работает как раньше (регрессия).
- Полная регрессия `entryPackageApplicationService.test.ts` (в т.ч. существующие scope-race тесты,
  строки ~763-935 по данным исследования) — адаптируются под новую claim-семантику, не удаляются.

**Зависит от.** Change 1, Change 2, Change 3 (open-position должен уже быть owner-aware до того, как
protection начнёт делегировать в него при живом multi-owner), Change 4 (желательно, для согласованности
recovery раньше активации).

**Состояние после.** Physical scope может честно обслуживать несколько same-side cycles; close и
open-position уже корректны для этого случая; protection временно заблокирован для shared scope.

**Осознанно вне scope.** Сам pair-owned protection redesign (Changes 6–8); поддержка opposite-side
(намеренно остаётся запрещённой согласно требованию пользователя); любой netting/portfolio-движок.

---

### Change 6 — `abi-pair-owned-protection-state-foundation-v1`

**Цель.** Дать protection-подсистеме те же foundation-примитивы, что Change 1 дал ownership-цепочке:
identity-схему и durable-модель для будущих per-cycle stop/take-ордеров, **без изменения текущего
поведения** `PUT .../protection` (guard из Change 5, если она уже применена, продолжает действовать
неизменно).

**Что меняется.**
- `src/domain/entryPackageOrderIdentity.ts`: расширение схемы orderLinkId новыми ролями (`"stop"`,
  `"take"` вместо/наряду с `"entry"`), с той же детерминированной `abi-ep-{sha256(...)}` генерацией.
- Correlation record: новые additive-поля для хранения protection-ордеров cycle — отдельные от
  entry-ордера (`order_link_id`/`order_id` заняты entry), например `stop_order_link_id`,
  `stop_order_id`, `take_order_link_id`, `take_order_id`, плюс собственный statuses/generation при
  необходимости — конкретная форма решается в design-фазе этого change.
- `src/exchange/bybitAdapter.ts`: DTO/method-примитивы для conditional (reduce-only stop/take) ордеров,
  если ещё не покрыты существующими `createOrder`/`cancelOrder` (техническая проверка — риск §6.4). На
  этом этапе примитивы **не вызываются** из `ProtectionApplicationService` — только определяются и
  тестируются изолированно (payload-shape тесты против фикстур).
- `EntryPackageCorrelationRepository`: replay корректно восстанавливает новые поля.

**Какие инварианты отменяются.** Ни один поведенческий — `PUT .../protection` продолжает работать через
`/v5/position/trading-stop` (или через guard из Change 5, если он уже применён) в точности как до этого
change.

**Новые инварианты.** "Protection-ордер идентичность (`stop`/`take` orderLinkId) детерминирована и
стабильна per cycle per generation, так же как entry-ордер." "Correlation record способна durable хранить
собственные protection-ордера cycle независимо от entry-ордера того же cycle."

**Затрагиваемые слои.** `src/domain/entryPackageOrderIdentity.ts`,
`src/correlation/entryPackageExecutionRecord.ts`, `src/correlation/entryPackageCorrelationRepository.ts`,
`src/exchange/bybitAdapter.ts` (только новые примитивы, не переключение существующих вызовов).

**HTTP-контракты.** Не меняются.

**Обязательные тесты.**
- Детерминированность генерации `stop`/`take` orderLinkId (аналог существующих entry-order-identity
  тестов).
- Replay корректно восстанавливает новые protection-ордер-поля (включая backward-compat со старыми
  записями без них).
- Adapter-примитивы для conditional-ордеров — payload-shape тесты против фикстур Bybit-ответов, без
  реального вызова из бизнес-логики.
- Регрессия `protectionApplicationService.test.ts` — **без изменений**, `PUT .../protection` ведёт себя
  идентично состоянию до этого change.

**Зависит от.** Change 1 (использует ту же схему записи/replay).

**Состояние после.** Инфраструктура для pair-owned protection существует и протестирована изолированно;
production-поведение `PUT .../protection` не меняется.

**Осознанно вне scope.** Любое изменение поведения `ProtectionApplicationService`/`CloseApplicationService`
(это Changes 7 и 8).

---

### Change 7 — `abi-pair-owned-protection-execution-v1`

**Цель.** Архитектурная идея №4 — переключить `PUT .../protection` с shared position-level protection на
pair-owned reduce-only conditional exit orders per cycle, снять временный guard из Change 5.

**Что меняется.**
- `ProtectionApplicationService` перестаёт (либо для scope с >1 owner — либо полностью, решение по
  совместимости, см. риск §6.7) вызывать `/v5/position/trading-stop` и вместо этого создаёт/обновляет/
  отменяет собственные reduceOnly conditional stop-market/take-profit ордера для данного cycle через
  примитивы из Change 6, с qty = `remaining_quantity`.
- Bounded confirmation для protection-ордеров зеркалит существующую bounded confirmation для entry
  (`packageConfirmation.ts`).
- Guard из Change 5 ("fail closed при >1 owner") снимается для scope, где protection теперь реализована
  через conditional-ордера.

**Какие инварианты отменяются/заменяются.** protection-execution spec целиком (position-level
`setTradingStop`, "both legs together in a single write", read-back verification против агрегированной
позиции) заменяется на per-cycle conditional-order lifecycle (create/confirm/cancel/replace), аналогично
существующей entry-package confirmation-модели.

**Новые инварианты.**
- Protection каждого cycle полностью независим от protection любого другого cycle на том же physical
  scope.
- Bounded confirmation для protection-ордеров: fail closed при неоднозначности, зеркалит entry-package.

**Затрагиваемые слои.** `src/services/protection/protectionApplicationService.ts` (значительный
рефакторинг). Не расширяет `CloseApplicationService` — это Change 8.

**HTTP-контракты.** `PUT .../protection` — форма не меняется (по-прежнему `stop_price`/`take_price`).
Убирается временный код `shared_scope_protection_unsupported`, введённый в Change 5 (contract narrows
back to fewer error cases — обратно совместимо, просто меньше 4xx-путей).

**Обязательные тесты.**
- Два same-side cycle с разными stop/take на одном physical scope: оба подтверждаются независимо,
  каждый — со своим orderLinkId.
- Single-owner регрессия (в зависимости от решения риска §6.7 — либо байт-в-байт то же поведение через
  fallback на `setTradingStop`, либо явно новое поведение через conditional-ордера, задокументированное
  как намеренное изменение).
- Bybit reject/partial-confirm сценарии для conditional-ордеров — bounded retry, fail closed при
  неоднозначности.
- Полная регрессия `protectionApplicationService.test.ts` под новой моделью.

**Зависит от.** Change 6 (identity/data model), Change 5 (нужны реально существующие multi-owner scopes
и снимаемый guard), Change 3 (protection делегирует в open-position-resolution).

**Состояние после.** `PUT .../protection` честно и независимо обслуживает каждый cycle на shared scope.
Protection-ордера ещё не отменяются автоматически при close (это Change 8) — до его прихода close
(Change 2) закрывает позицию, но собственные protection-ордера закрытого cycle могут остаться висеть на
бирже как dangling reduceOnly-ордера, что явно фиксируется как временное ограничение.

**Осознанно вне scope.** Интеграция с close (Change 8); поддержка opposite-side; динамический
пересчёт protection (например, trailing stop, синхронизированный между cycles).

---

### Change 8 — `abi-pair-owned-protection-close-cleanup-v1`

**Цель.** Устранить временное ограничение Change 7 (dangling protection-ордера после close) —
`CloseApplicationService` при закрытии cycle отменяет его собственные protection-ордера как часть
терминального перехода.

**Что меняется.** `CloseApplicationService` расширяется: при durable close cycle отменяет
(cancel + bounded confirm, тот же паттерн, что уже применяется к entry-ордеру в close-execution) его
собственные `stop`/`take` conditional-ордера (по данным из Change 6) до/как часть закрытия
`remaining_quantity`. `terminal_closed` теперь гейтится на **оба** постусловия: (а) live position
уменьшена ровно на `remaining_quantity` этого cycle, (б) собственные protection-ордера этого cycle
неактивны (отменены или уже терминальны).

**Какие инварианты отменяются/заменяются.** Постусловие close-execution ("terminal_closed требует
подтверждённого zero position size AND no attributable active entry-order remainder") расширяется:
дополнительно требуется отсутствие live protection-ордеров этого cycle.

**Новые инварианты.** "Close cycle гарантированно не оставляет собственных protection-ордеров висящими
на бирже после durable close — ни при single-owner, ни при multi-owner scope."

**Затрагиваемые слои.** `src/services/close/closeApplicationService.ts` (дополнение, не рефакторинг
основной логики close из Change 2).

**HTTP-контракты.** `DELETE .../open-position` — форма не меняется.

**Обязательные тесты.**
- Close одного cycle отменяет именно его protection-ордера, не трогая ордера соседнего same-side cycle.
- `terminal_closed` не достигается, пока protection-ордера этого cycle ещё живы/неоднозначны (fail
  closed на неоднозначности отмены, зеркалит существующий паттерн cancel-entry-order-first).
- Регрессия `closeApplicationService.test.ts` для scope без активных protection-ордеров (no-op путь).

**Зависит от.** Change 7 (нужны реально существующие protection-ордера для интеграционных тестов),
Change 2 (расширяет уже существующую pair-scoped close-логику).

**Примечание по объёму.** Если в ходе design-фазы Change 6/7 выяснится, что cancellation-логика
тривиальна (например, если Bybit-семантика позволяет использовать уже существующий cancel-путь
close-execution без нового кода), Change 8 можно слить в Change 7 — решение принимается по факту
scoping, не заранее. По умолчанию держим отдельно как более безопасный вариант.

**Состояние после.** Полная реализация всех четырёх целевых архитектурных идей пользователя; long+long и
short+short полностью и честно поддержаны, включая независимую protection с корректной уборкой при close;
long+short остаётся запрещённым, пока жива противоположная exposure.

**Осознанно вне scope.** Полноценный portfolio/netting engine; hedge mode; opposite-side coexistence.

---

## 4. Dependency graph

```
Change 1 (foundation: ownership)
   ├──> Change 2 (close, owner-aware)         ──┐
   ├──> Change 3 (open-position, owner-aware) ──┤
   └──> Change 4 (recovery, owner-aware)      ──┤
                                                 ├──> Change 5 (activation: same-side ownership + protection guard)
                              (2,3 напрямую;     │        │
                               4 — по соглас-    │        ├──> Change 6 (foundation: protection identity/state)
                               ованности)        │        │        │
                                                  │        │        └──> Change 7 (protection execution, снимает guard)
                                                  │        │                 │
                                                  │        │                 └──> Change 8 (close cancels own protection)
                                                  │        │                          ▲
                                                  └────────┴──────────────────────────┘ (Change 8 также зависит от Change 2)
```

Текстово: 1 → {2, 3, 4} (параллельно возможны) → 5 (требует 1,2,3, желательно 4) → 6 (требует 1, может
идти параллельно с 2/3/4/5) → 7 (требует 6, 5, 3) → 8 (требует 7, 2).

---

## 5. Какие существующие OpenSpecs должны быть изменены/superseded/удалены

- **`position-scope-exclusivity`** — **superseded** Change 5. Центральный инвариант заменяется. Спеку не
  удаляем физически (история), но переводим в архивный/historical статус, а действующей capability
  становится новая (`virtual-exposure-ownership` или аналог).
- **`open-position-resolution`** — **изменяется** Change 3 (два конкретных требования заменяются, см.
  Change 3 выше; wire-контракт остаётся прежним), остальное сохраняется.
- **`close-execution`** — **изменяется дважды**: Change 2 (ключевой разворот в источнике qty), затем
  Change 8 (дополнительное постусловие про protection-ордера); остальное (cancel-entry-order-first,
  unsupported_exchange_scope, идемпотентность) сохраняется без изменений.
- **`protection-execution`** — **изменяется трижды**: малое дополнение в Change 5 (guard), затем
  additive foundation в Change 6 (без изменения поведения), затем практически полная замена в Change 7.
- **`entry-cycle-recovery-resolution`** — **изменяется** Change 4 (атрибуционная логика), остальное
  (dual-query bounded retry, legacy pending_action guard, read-only гарантия) сохраняется.
- **`entry-package-execution`** — **дополняется** Change 1 (новые additive-поля/их заполнение) и Change 6
  (новые orderLinkId-роли), основной текст (order identity, create/cancel semantics, confirmation) не
  меняется.
- **`abi-position-management-api`, `abi-open-position-lookup-api`** — **только текстовые правки** prose
  (без изменения wire-схемы) в Changes 2, 3, 5, 7 — пояснить, что значения относятся к доле cycle, а не к
  физической позиции целиком; при необходимости — добавить новые коды ошибок (см. риск). Явно
  зафиксировать, что `GET .../open-position` не приобретает quantity-поле ни на одном шаге этой
  программы.
- **`exchange-instrument-identity`, `container-runtime`** — не затрагиваются.
- Отдельно, вне этой программы: **`abi-entry-package-exchange-canonical-confirmation-v1`** реализован,
  но не заархивирован в `openspec/changes/archive/` — рекомендуется провести housekeeping-архивацию
  до старта этой программы, чтобы baseline специй был чистым для дифов новых changes.

---

## 6. Риски и спорные архитектурные решения (закрыть до apply)

1. **Источник `filled_quantity`/`average_entry_price`/`first_fill_at_ms`.** Все три должны браться из
   данных собственного ордера cycle (исполненное qty/средняя цена/время именно этого ордера), а не из
   агрегированной позиции. Нужно технически подтвердить, что Bybit `/v5/order/realtime`/
   `/v5/order/history` действительно отдают эти три величины на уровне ордера с достаточной точностью
   (exact-decimal для qty/price) — рекомендуется короткий technical spike против Demo API **до**
   написания proposal Change 1. Это уже не отложенный риск, а часть основной задачи Change 1.

2. **Политика допуска дрейфа.** `sum(remaining_quantity активных same-side owners)` может разойтись с
   живым агрегированным размером позиции (округления qtyStep у разных входов, ручное вмешательство,
   частичные fills). Нужно явно решить: fail-closed при превышении допуска (соответствует общей
   философии кода "fail closed over guessing") против soft-warn-and-proceed. Рекомендация — fail closed,
   но требуется явное подтверждение архитектора/пользователя, т.к. это может блокировать легитимные
   операции при временной рассинхронизации.

3. **Таксономия ошибок.** Opposite-side rejection и protection-guard для shared scope можно отдавать как
   существующий `internal_error` (не меняя "закрытый словарь" ошибок) либо ввести точные новые коды
   (лучше для наблюдаемости/дебага, но формально это additive-изменение текста closed-vocabulary таблиц
   в `abi-position-management-api`/`abi-entry-package-api`). Нужно решение до Change 5.

4. **Технические детали conditional-ордеров Bybit V5** для Change 6/7 (triggerBy, типы Stop/TakeProfit,
   корректное сосуществование нескольких reduceOnly conditional ордеров на один symbol в one-way mode)
   — рекомендуется отдельный technical spike перед написанием proposal Change 6.

5. **Observability пробел.** Сегодня нет метрик/событий, различающих scope contention или multi-owner
   состояние (`src/observability/events.ts` не имеет соответствующих полей). Без добавления полей
   (owner count, side, drift) новый инвариант станет операционно невидимым — рекомендуется добавить как
   часть Change 1 (структура) и Change 5 (события активации).

6. **Философский разворот в close (Change 2).** Явно зафиксировать как осознанное решение: до сих пор
   close принципиально не доверял ABI-recorded количествам именно чтобы избежать дрейфа; теперь для
   multi-owner случая это единственный физически возможный источник. Это решение нужно явно одобрить,
   а не оставлять неявным побочным эффектом.

7. **Совместимость protection в single-owner случае (Change 7).** Нужно решить: сохраняется ли
   `/v5/position/trading-stop` как fallback-путь для scope с ровно одним owner (проще, меньше нового
   кода на бирже) или всё protection полностью переезжает на conditional-ордера даже для single-owner
   (единообразнее, но масштабнее рефакторинг и меняет поведение даже для сегодняшнего mainline-сценария).

8. **Рассмотренная и отклонённая альтернатива: Bybit hedge mode.** Positional hedge mode
   (`positionIdx` 1/2) нативно разделяет long/short на две физические позиции и тривиально решил бы
   часть проблемы long+short — но НЕ решает основной запрошенный сценарий (несколько cycles **одной**
   стороны на одном symbol всё равно агрегируются Bybit в одну физическую позицию на сторону), требует
   переписать все hardcoded `positionIdx=0` предположения по всей кодовой базе, и не устраняет
   необходимость virtual ledger. Упомянуто для полноты, не рекомендуется как альтернатива этой программе.

9. **`AGENTS.md` устарел** (описывает до-entry-package архитектуру) — не связано с этой программой,
   но стоит почистить отдельно, чтобы не путать будущих исполнителей changes.

10. **Возможное слияние Change 8 в Change 7.** См. примечание в Change 8 — решение по факту scoping,
    не заранее.

---

## 7. Финальный рекомендуемый порядок реализации и smoke-verification

0. **Housekeeping (вне программы):** заархивировать `abi-entry-package-exchange-canonical-confirmation-v1`
   в `openspec/changes/archive/`, чтобы baseline специй был чист.
1. **Закрыть риски §6** (источник filled_quantity/avgPrice/first_fill, политика дрейфа, таксономия
   ошибок, conditional-order детали, single-owner fallback в protection) — до написания первого proposal.
2. **Change 1** → apply → регрессия всего существующего test suite (ожидается 0 поведенческих изменений)
   → smoke: restart процесса на существующих данных, подтвердить, что single-owner scopes резолвятся
   идентично.
3. **Change 2** → apply → синтетические multi-owner тесты + полная регрессия close → smoke: реальный
   close на Bybit Demo для обычного single-cycle сценария, побайтово то же поведение, что до change.
4. **Change 3** → apply → аналогично → smoke: `GET open-position` на реальной Demo-позиции, `avgPrice`/
   `first_fill_at_ms` совпадают с тем, что сегодня отдаёт Bybit, для single-owner случая; ответ по-прежнему
   не содержит quantity-поля.
5. **Change 4** → apply → smoke: убить/перезапустить процесс посреди активного trade cycle на Demo,
   подтвердить recovery-state не изменился относительно baseline.
6. **Change 5 (активация)** → apply → это шаг с наибольшим риском живого поведения → smoke на Bybit
   Demo: два same-side entry-package на одном symbol от разных trade cycles оба успешно создаются и
   сосуществуют; третья opposite-side попытка отклоняется; `PUT protection` на любом из двух active
   owners отклоняется новым guard-кодом; close одного cycle уменьшает физическую позицию строго на его
   долю, второй cycle остаётся нетронутым (позиция и его открытость).
7. **Change 6** → apply → smoke: identity-генерация и replay protection-полей работают изолированно;
   `PUT .../protection` ведёт себя байт-в-байт как до этого change.
8. **Change 7** → apply → smoke на Bybit Demo: у двух same-side cycles независимые stop/take
   conditional-ордера, каждый подтверждается независимо.
9. **Change 8** → apply → smoke на Bybit Demo: close одного cycle отменяет именно его conditional-ордера,
   не трогая ордера второго; `terminal_closed` достигается только после обоих постусловий.

Каждый шаг — самостоятельно принимаемый OpenSpec change с собственным proposal/design/tasks, отдельным
review и отдельным apply — согласно ограничению не смешивать несколько архитектурных ответственностей
в одном change.
