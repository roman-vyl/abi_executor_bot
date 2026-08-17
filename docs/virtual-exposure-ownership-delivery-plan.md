# Мастер-план: от position-scope-exclusivity к virtual same-side exposure ownership

> Это мастер-план последовательности будущих OpenSpec changes (GitHub Issue #3: "Backlog: virtual
> position ledger for shared same-symbol exposure"). Сам план не является OpenSpec change и ничего не
> реализует — каждый пункт раздела 2 должен быть оформлен как отдельный OpenSpec change (proposal/
> design/tasks) со своим review и apply.

> **Ревизия v2 по итогам первого review.** Внесены четыре исправления: (1) единое поле `owned_quantity`
> разделено на immutable/mutable части; (2) исправлена фактическая ошибка — `GET .../open-position` НЕ
> возвращает quantity/size на wire-уровне (проверено по `src/domain/openPositionApi.ts:4-14`), per-cycle
> quantity остаётся строго внутренней; (3) бывший Change 6 (protection redesign) разделён на три
> отдельных change — state-foundation / execution / close-cleanup; (4) `average_entry_price`/
> `first_fill_at_ms` подняты в Change 1 с той же строгостью sourcing, что и quantity. Программа выросла
> с 6 до 8 changes.

> **Ревизия v3 по итогам второго review.** Два дальнейших уточнения:
> (1) **Partial-fill semantics.** v2 объявлял `filled_quantity` immutable, "заполняется один раз на
> confirmation". Это опровергается кодом: `src/services/entryPackage/packageConfirmation.ts:220-236`
> явно относит `PartiallyFilled` к **live** (не terminal) статусам ордера — комментарий буквально
> говорит "a still-open partially-filled state can still add exposure" — а
> `src/services/entryPackage/entryPackageApplicationService.ts:605-611` заводит исходы `partial_fill` и
> `full_fill` в один и тот же `status: "applied"`, никак их не различая. То есть к моменту `applied`
> ABI не гарантированно видит финальное количество исполнения — это подтверждённый, а не гипотетический
> риск.
> (2) **Небезопасная activation-граница Change 7/8.** В v2 Change 7 уже снимал shared-scope guard,
> оставляя okно, где protection-ордера закрытого cycle могли повиснуть на бирже до Change 8. Граница
> сдвинута: Change 7 строит и тестирует полный lifecycle pair-owned protection-ордеров, но **не снимает**
> guard — производственное поведение `PUT .../protection` для shared scope не меняется. Guard снимается
> только в Change 8, после того как close уже умеет neutralize собственные protection-ордера cycle.
> Активация protection теперь целиком происходит в одном change, как и активация базового ownership в
> Change 5 — ни один applied change в программе больше не оставляет систему в небезопасном промежуточном
> production-состоянии.

> **Ревизия v4 по итогам третьего review (после OpenSpec-proposal для Change 1).** Три
> архитектурных уточнения, применённые пока только к Change 1/2/3 ниже (Changes 4–8 всё ещё написаны
> по модели v3 и требуют отдельного согласующего прохода — см. примечание в конце Change 3):
> (1) **Absolute quantity — приватное состояние ABI.** Runtime не должен знать и не должен передавать
> ABI абсолютное exchange quantity при управлении позицией. Целевая граница: Runtime выражает
> относительное намерение (например, close 100% cycle) → ABI резолвит его в абсолютное количество из
> собственного per-cycle state → ABI материализует Bybit-ордер. Change 1 только формулирует эту
> границу как архитектурное решение; сам механизм (close-контракт, резолюция quantity) — работа
> Change 2, не Change 1.
> (2) **Никакого mutable `remaining_quantity` раньше необходимости.** Расследование показало, что
> большая часть foundation уже существует в `EarlyExecutionObservation`
> (`cumulative_filled_qty`/`avg_execution_price`/`order_status`, уже sourced из own entry order).
> Пока V1 close поддерживает только полный close (canonical fraction = 1), отдельное mutable поле
> "сколько ещё осталось" не нужно: до close owned exposure = финальный `cumulative_filled_qty`, после
> успешного полного close cycle terminally closed ⇒ owned exposure = 0 без отдельного поля. Change 1
> больше не создаёт `remaining_quantity`/`owned_remaining_quantity`; Change 2 введёт такое поле, только
> если для него появится настоящая необходимость (partial close).
> (3) **`first_fill_at_ms` — не часть virtual-exposure accounting.** Его единственная роль — Runtime
> передаёт его Strategy Engine для определения entry-strategy-bar. Он не нужен ни для ownership
> quantity, ни для close, ни для protection. Change 1 больше не вводит `first_observed_at`/
> `first_fill_at_ms`: ABI-шное время первого наблюдения фиксирует момент, когда ABI **заметило** fill,
> а не момент самого fill, и может отстать от границы следующей strategy bar — использование его как
> entry-bar proxy было бы тихо неверным. Вопрос "какого own-order/execution evidence достаточно для
> корректной entry-bar identity" явно передан в Change 3.

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

8. **Partial fill — это уже смоделированное, не гипотетическое состояние.** `PARTIAL_FILL_STATUSES`
   (`packageConfirmation.ts:24`) относится к `isLiveOrderStatus()` (`packageConfirmation.ts:234-236`),
   наравне с `New`/`Untriggered`/`Triggered` — то есть частично исполненный entry-ордер этого cycle
   считается системой **живым**, способным дальше добирать исполнение, а не финальным фактом. При этом
   `confirmation.kind === "partial_fill"` и `"full_fill"` оба ведут в один и тот же `status: "applied"`
   (`entryPackageApplicationService.ts:605-611`) — статус записи сам по себе не отличает "финально
   исполнено" от "частично исполнено, ордер ещё жив". Любая модель per-cycle exposure обязана строиться
   вокруг этого факта, а не поверх него.

### Архитектурное решение: где живёт virtual exposure state

**Не заводим новый durable store — и не заводим новых полей вообще, пока в них нет доказанной
необходимости.** Расследование для Change 1 (см. его OpenSpec `design.md`) показало: то, что
изначально казалось необходимым набором из пяти новых additive-полей, почти целиком уже существует в
`EntryPackageExecutionRecord.early_execution_observation` — `cumulative_filled_qty`,
`avg_execution_price`, `order_status`, уже sourced исключительно из **собственного entry-ордера**
этого cycle (`item.cumExecQty`/`item.avgPrice`/`item.orderStatus`, `packageConfirmation.ts:366-385`),
уже обновляемые в каждой легитимной точке наблюдения (initial confirmation, repeat-PUT revalidation,
cancel discovering a fill), уже никогда не регрессирующие на практике (только не проверено формально
— это и закрывает Change 1). Change 1 **формализует и усиливает уже существующие own-order fill
facts**, не копирует master-plan sketch механически:

- **Own-order sourcing** (уже верно сегодня, Change 1 не меняет источник, только фиксирует
  invariant): `cumulative_filled_qty`/`avg_execution_price`/`order_status` происходят только из
  собственного entry-ордера `(strategy_instance_id, trade_cycle_id)`, никогда из агрегированной
  Bybit-позиции.
- **Finality** — не отдельное durable поле, а производный факт из уже durable `order_status`:
  `PartiallyFilled` — live, `cumulative_filled_qty` в этот момент снимок, не финал; `Filled` (или
  terminal-without-fill) — final, значения можно доверять без переспроса. Переиспользуется
  существующая terminality-классификация (`isTerminalOrderStatus`), не вводится redundant boolean.
- **Monotonicity**: для одной binding/generation `cumulative_filled_qty` может только расти или
  оставаться тем же — регрессия fail closed и на live save, и на replay. `average_entry_price` может
  меняться в любую сторону при новом legitimate fill observation, не обязана быть монотонной.
- **Side**: не отдельное поле — `record.desired_entry.side`, безопасно читаемое, т.к. verified
  invariant гарантирует, что `desired_entry` не обнуляется, пока существует хоть какой-то fill.
- **`first_fill_at_ms`/`first_observed_at` — явно НЕ вводится в Change 1** (см. ревизию v4 выше):
  единственный потребитель этого факта — entry-bar identity для Strategy Engine через Runtime, а
  ABI-шное время наблюдения не является надёжным proxy для него. Этот вопрос — предмет Change 3.
- **Quantity ownership boundary** (новое явное архитектурное решение, а не реализация): per-cycle
  absolute fill/exposure quantity — приватное execution state ABI. Будущие Runtime-команды управления
  позицией выражают относительное намерение для идентифицированного trade cycle; ABI резолвит это
  намерение в абсолютное exchange quantity из собственного authoritative per-cycle state. Change 1
  не меняет Runtime, не меняет HTTP-контракты, не реализует close_fraction — конкретный close-контракт
  проектируется в Change 2.
- **Никакого mutable `remaining_quantity`/`owned_remaining_quantity` в Change 1**: пока V1 close
  поддерживает только полный close (canonical fraction = 1, см. Change 2), у cycle ровно два
  состояния — открыт (owned exposure = финальный `cumulative_filled_qty`) или terminally closed
  (owned exposure = 0, это уже подразумевает `status`, отдельное поле не нужно). Не путать с уже
  существующим `EarlyExecutionObservation.remaining_qty`, который означает неисполненный остаток
  **входного** ордера, а не остаток открытой позиции.
- **Repository preparation**: допустим минимальный additive query, позволяющий synthetic-тестам
  перечислить несколько active records одного physical scope — но `byScope`-семантика владения не
  меняется, production exclusivity не снимается, `EntryPackageApplicationService` по-прежнему не
  создаёт multi-owner state. Это подготовка потребителей Changes 2–5, не активация.

Это прямое продолжение уже сформулированного в спеке принципа "scope ownership derived from existing
durable correlation state, not a new store" (position-scope-exclusivity spec L35-46), доведённое до
логического предела: не только "не заводить новый store", но и "не заводить новых полей там, где
существующие уже корректны".

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
(create/replace/cancel/confirm, **без снятия guard** — производственно инертен), отдельно интеграция с
close (cancellation своих protection-ордеров при закрытии cycle) **и только там** снятие guard —
активация. Это то же разделение foundation/activation, что уже применено к базовой ownership-цепочке
(Changes 1 → 5), доведённое (после ревизии v3) до той же гарантии: ни один applied change не оставляет
систему в небезопасном промежуточном состоянии.

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
и самым безопасным шагом среди "базовых" changes. Тот же принцип (после ревизии v3) применён и к
protection: lifecycle строится и тестируется в Change 7 production-инертно, активация — только в Change 8.

---

## 1. Итог целевой архитектуры

- Physical scope (`account+category+symbol+positionIdx=0`) может иметь несколько активных owners
  (`strategy_instance_id, trade_cycle_id`), но только **одной стороны** одновременно: long+long и
  short+short разрешены, long+short — запрещён, пока жива хоть одна exposure противоположной стороны.
- Virtual exposure state — **ноль новых полей** в Change 1: формализация уже существующего
  `EarlyExecutionObservation` (`cumulative_filled_qty`/`avg_execution_price`/`order_status`, уже
  sourced из own entry order) плюс monotonicity-инварианты и производная finality. `physical_side`
  читается из `desired_entry.side`, не хранится отдельно. `first_fill_at_ms` не вводится — это не
  часть virtual-exposure accounting, его роль (entry-bar identity для Engine) решает Change 3.
  Mutable `remaining_quantity` не вводится, пока V1 close остаётся full-close-only (см. Change 2).
  Никакого нового durable store.
- `open-position` для конкретного cycle отвечает исходя из **собственных** `average_entry_price`/
  `first_fill_at_ms` этого cycle (из данных его собственного ордера), а не из агрегированной
  Bybit-позиции — агрегированный live-запрос остаётся только как sanity-проверка существования/стороны.
  **Wire-контракт не меняется и не расширяется quantity-полем** — quantity остаётся внутренним понятием.
- `close` для конкретного cycle уменьшает физическую позицию ровно на `remaining_quantity` этого cycle
  (reduceOnly) — но только после того, как собственный entry-ордер cycle подтверждён терминальным; при
  единственном владельце поведение идентично сегодняшнему (используется live aggregate size, как раньше,
  для устранения дрейфа).
- `protection` до Change 8 явно блокируется (fail closed) для scope с >1 активным owner; сам redesign
  (в три этапа — foundation/execution-lifecycle/close-cleanup+активация) переводит protection на
  pair-owned reduceOnly conditional stop/take-ордера с собственными orderLinkId на cycle. Guard снимается
  только в Change 8, не раньше.
- Recovery перестаёт полагаться на side-match агрегированной позиции как на доказательство "моя
  позиция" — авторитетным становится статус **собственного** ордера cycle.
- Публичные HTTP-контракты (`PUT entry-package`, `GET open-position`, `PUT protection`,
  `DELETE open-position`) **не меняются по форме** — меняется только семантика ("full remainder" теперь
  означает "весь остаток именно этого cycle", а не физической позиции). Текстовые правки нужны только
  в prose двух OpenAPI-специй (`abi-position-management-api`, `abi-open-position-lookup-api`).
- Каждый applied change в программе (1–8) оставляет систему в безопасном, полностью определённом
  production-состоянии — активационных моментов ровно два: Change 5 (базовое ownership) и Change 8
  (protection).

---

## 2. Упорядоченная последовательность changes

| № | change-id | Capability(ies) | Тип |
|---|---|---|---|
| 1 | `abi-virtual-exposure-state-foundation-v1` | новая: virtual-exposure-state (+ additive к entry-package-execution) | Data model, без изменения поведения |
| 2 | `abi-pair-scoped-close-execution-v1` | `close-execution` | Consumer prep (owner-aware, ветвление) |
| 3 | `abi-pair-scoped-open-position-resolution-v1` | `open-position-resolution` | Consumer prep (owner-aware, wire-контракт без изменений) |
| 4 | `abi-entry-cycle-recovery-attribution-v1` | `entry-cycle-recovery-resolution` | Consumer prep (owner-aware) |
| 5 | `abi-same-side-virtual-exposure-ownership-v1` | супersedes `position-scope-exclusivity`; малый guard в `protection-execution` | **Activation #1** — базовое ownership |
| 6 | `abi-pair-owned-protection-state-foundation-v1` | новая: pair-owned protection identity/state (+ additive к `protection-execution`) | Data model/identity, без изменения поведения |
| 7 | `abi-pair-owned-protection-execution-v1` | `protection-execution` | Execution lifecycle, **production-инертно** (guard из Change 5 не снимается) |
| 8 | `abi-pair-owned-protection-close-cleanup-v1` | `close-execution` (расширение) | Close-cleanup + **Activation #2** — снимает guard |

Changes 2, 3, 4 формально зависят только от Change 1 и **не зависят друг от друга** — их можно вести
параллельно/в любом порядке. Change 8 можно слить с Change 7 только если объединённый change по-прежнему
не активирует guard-снятие до того, как cleanup-логика полностью реализована и протестирована — то есть
слияние меняет группировку работы, но не меняет правило "guard снимается последним". Ниже дан
рекомендованный линейный порядок для одной команды.

---

## 3. Детали по каждому change

### Change 1 — `abi-virtual-exposure-state-foundation-v1`

> Статус: OpenSpec-предложение (proposal/design/tasks/spec delta) уже создано в
> `openspec/changes/abi-virtual-exposure-state-foundation-v1/` и синхронизировано с этим разделом.
> Ещё не применено.

**Цель.** Формализовать и усилить уже существующие per-cycle own-order fill facts
(`EarlyExecutionObservation`), чтобы следующие changes могли безопасно использовать их для virtual
exposure attribution — не меняя ничьё наблюдаемое поведение и **не копируя механически** исходный
master-plan sketch из пяти новых parallel-полей.

**Что меняется.** Расследование показало: `cumulative_filled_qty`/`avg_execution_price`/
`order_status` уже существуют на `EntryPackageExecutionRecord.early_execution_observation`
(`entryPackageExecutionRecord.ts:53-59`), уже sourced исключительно из собственного entry-ордера
cycle (`packageConfirmation.ts:366-385`), уже обновляются на всех нужных наблюдениях. Change 1 **не
добавляет новых полей** ни в `EntryPackageExecutionRecord`, ни в `EarlyExecutionObservation`. Вместо
этого:
- Новый чистый предикат `isFillFactFinal(observation)` в `packageConfirmation.ts`, производный от уже
  durable `order_status` (переиспользует существующий `isTerminalOrderStatus`) — не отдельный
  durable finality-флаг.
- Новая валидация monotonicity в `EntryPackageCorrelationRepository.save()` и `replay()`:
  `cumulative_filled_qty` не может уменьшаться для одной и той же пары — fail closed и на live-write,
  и при replay. `avg_execution_price` не обязана быть монотонной.
- `physical_side` и "owned exposure quantity" специфицированы как **читаемые контракты**, не новые
  поля: side — из `record.desired_entry.side` (безопасно, т.к. verified invariant гарантирует, что
  desired_entry не обнуляется, пока существует fill); owned exposure — `cumulative_filled_qty` после
  `isFillFactFinal`, ровно из-за **quantity ownership boundary** решения (см. ниже) и full-close-only
  V1 (Change 2) — mutable `remaining_quantity`/`owned_remaining_quantity` НЕ вводится в этом change.
- `first_fill_at_ms`/`first_observed_at` НЕ вводится — не часть virtual-exposure accounting (см.
  ревизию v4). Его единственная роль (entry-bar identity для Engine) — предмет Change 3.
- Новый additive, непроиндексированный repository-метод `findActiveRecordsForScope(category,
  symbol)` — линейный скан по уже существующему `byCompositeKey`, доказывает, что repository способен
  представить несколько active records одного scope, **не трогая** `byScope`/`findOwnerByScope`/
  `applyScopeClaimOnWrite`/`rebuildScopeIndexFromReplay` вообще. Эволюция самого `byScope` в
  multi-owner-способную форму сознательно отложена до Change 5 (активации) — у Changes 2–4 нет
  потребителя для неё.
- **Quantity ownership boundary** — новое явное архитектурное решение design.md: per-cycle absolute
  fill/exposure quantity — приватное execution state ABI; будущие Runtime-команды выражают
  относительное намерение; ABI резолвит его в абсолютный exchange quantity. Change 1 формулирует эту
  границу, но не реализует её: не меняет Runtime, не меняет HTTP-контракты, не проектирует
  close-контракт (это Change 2).

**Какие инварианты отменяются.** Ни один — ни поведенческий, ни на уровне представления данных.
`byScope` не трогается вообще.

**Новые инварианты.**
- `cumulative_filled_qty` монотонно неубывает для одной binding/generation — регрессия fail closed и
  на live save, и при replay.
- Finality — производный факт от `order_status` (`isFillFactFinal`), не отдельное durable состояние.
- Repository может представить и перечислить несколько active non-durably-closed records одного
  scope (через новый query), не меняя production claim-политику.

**Затрагиваемые слои.** `src/services/entryPackage/packageConfirmation.ts` (новый предикат, без
изменения формы `EarlyExecutionObservation`), `src/correlation/entryPackageCorrelationRepository.ts`
(новая валидация в `save()`/`replay()`, новый additive query). Не затрагивает
`entryPackageExecutionRecord.ts`'s type shape, `services/close`, `services/openPosition`,
`services/protection`, `services/entryCycleRecovery`, HTTP routes/DTO, Runtime, MDS.

**HTTP-контракты.** Не меняются.

**Обязательные тесты.**
- Partial-then-full-fill sequence для одной binding: `cumulative_filled_qty` растёт между двумя
  наблюдениями (repeat-PUT revalidation); `avg_execution_price` может измениться в любую сторону;
  `isFillFactFinal` — false после partial, true после full.
- `save()` отклоняет запись с меньшим `cumulative_filled_qty`, чем уже проиндексировано для той же
  пары; принимает запись, где количество не уменьшилось.
- Replay: монотонно-согласованная последовательность реплеится успешно; последовательность с
  регрессией — fail closed с описательной причиной.
- `isFillFactFinal`: `null` → false; live `order_status` → false; terminal `order_status` → true.
- `findActiveRecordsForScope`: синтетически сидированные (напрямую в repository, минуя
  `EntryPackageApplicationService`) два same-side active record одного scope оба возвращаются;
  durably-closed record исключается.
- Полная регрессия существующих тестов (`entryPackageCorrelationRepository.test.ts`,
  `entryPackageApplicationService.test.ts`, `closeApplicationService.test.ts`,
  `protectionApplicationService.test.ts`, `openPositionResolutionService.test.ts`,
  `entryCycleRecoveryResolutionService.test.ts`) — без изменений.

**Зависит от.** Ничего (первый шаг).

**Состояние после.** Own-order fill facts (`cumulative_filled_qty`/`avg_execution_price`/
`order_status`) формально усилены monotonicity-инвариантом и производной finality; quantity ownership
boundary зафиксирована как решение; repository доказанно способен представить multi-owner state на
synthetic-фикстурах. Production-поведение системы идентично сегодняшнему;
`position-scope-exclusivity` продолжает управлять фактическим поведением без изменений.

**Осознанно вне scope.** `first_fill_at_ms`/entry-bar resolution для Engine; mutable
`remaining_quantity`/partial close; close-контракт и close_fraction; любое изменение claim-политики,
close, open-position, protection, recovery; ABI → Runtime fill push; Runtime/MDS changes; эволюция
`byScope`.

---

### Change 2 — `abi-pair-scoped-close-execution-v1`

**Цель.** Реализовать архитектурную идею №3 и quantity ownership boundary из Change 1 — close
конкретного cycle через pair quantity, материализуемую ABI из собственного per-cycle state, а не
через закрытие всей физической позиции — заранее, безопасно, под ветвлением "если owner один — старое
поведение", и корректно относительно partial-fill semantics (собственный entry-ордер cycle должен быть
терминализирован прежде, чем его `cumulative_filled_qty` можно доверять как финальное).

**High-level contract (уточнён после Change 1's quantity ownership boundary):**

```
Runtime sends relative close intent (this trade cycle, canonical fraction = 1 for V1)
  → ABI resolves authoritative pair quantity from its own cumulative_filled_qty
    (once isFillFactFinal for this cycle's own entry order)
  → ABI materializes the absolute Bybit reduceOnly close qty
```

Runtime не передаёт и не получает абсолютное BTC-количество. **Для V1 рекомендуется разрешить только
полный close (canonical fraction = 1)**, если не появится доказанная необходимость в partial-close
lifecycle — произвольный partial close выносится в отдельное будущее расширение, а не проектируется
здесь. Детальный wire DTO этого change (форма relative-intent контракта) **не проектируется на уровне
master-plan** — это работа самого Change 2 на design-этапе.

**Что меняется.** `CloseApplicationService` (`src/services/close/closeApplicationService.ts:153-179`):
- Если у scope ровно один активный owner — поведение **не меняется**: reduceOnly qty = live aggregate
  `row.size` (как сегодня, максимально доверяя exchange, не ABI-шным числам — сохраняем текущую
  философию "never trust ABI-recorded quantity" для этого случая).
- Если owners > 1: сначала, как и сегодня для единственного owner, гарантируется терминальность
  **собственного** entry-ордера closing cycle (cancel + bounded confirm, тот же паттерн, что уже
  применяется сегодня к единственному owner — просто теперь явно per-cycle, а не подразумеваемо
  per-scope); только после этого `cumulative_filled_qty` этой записи (из `early_execution_observation`,
  формализованного в Change 1) считается финальным и авторитетным. reduceOnly qty = это значение,
  **clamped** сверху живым остатком агрегированной позиции — но clamp допустим **только** в пределах
  заранее определённого малого допуска на биржевое округление (например, один `qtyStep`), не как
  универсальная защита. Любое расхождение за пределами этого допуска — **fail closed** с явным кодом
  "требуется reconciliation", а не молчаливый clamp: clamp "вниз" по своей сути мог бы срезать чужую
  (соседнего cycle) долю, если ledger и биржа разошлись сильнее, чем на округление.
- Release-семантика: при durable close этого cycle запись убирается из `owners`-множества scope
  (структура `byScope`, если Change 5 к этому моменту её уже ввела — см. примечание о том, что Change
  1 сознательно не трогает `byScope`); сторона (`side`) scope очищается лишь когда множество owners
  становится пустым.

**Какие инварианты отменяются/заменяются.** close-execution spec L110-124 ("close size сурсится
исключительно из live aggregate query, никогда из ABI-recorded/calculated quantity") — заменяется на
"при единственном owner — как раньше; при множественном — обязательно из ABI-resolved
`cumulative_filled_qty`, верифицированного терминальностью собственного entry-ордера, т.к. exchange
физически не знает про доли между cycles". Это единственный настоящий разворот философии в этой
программе; квалифицируется отдельно как риск (см. §6).

**Новые инварианты.** "Close уменьшает физическую позицию ровно на долю closing cycle, оставляя чужие
доли нетронутыми"; "Runtime никогда не передаёт и не получает абсолютное exchange quantity — только
относительное намерение"; "release из owner-множества не подразумевает release всего scope, пока есть
другие активные owners"; "clamp против live aggregate допустим только в пределах явно определённого
малого допуска, никогда как замена reconciliation".

**Затрагиваемые слои.** `src/services/close/closeApplicationService.ts`,
`src/correlation/entryPackageCorrelationRepository.ts` (partial-release helper; возможно первая
реальная эволюция `byScope`, если она ещё не введена Change 5 — порядок между Change 2 и Change 5
уточняется на design-этапе). Domain: возможно `src/domain/positionScope.ts` для новых типов.

**HTTP-контракты.** `DELETE .../open-position` — форма (пустое тело, тот же response) не меняется для
V1 full-close-only. Если V1 остаётся full-close-only, relative-intent для close не требует нового поля
в запросе вообще ("close 100% этого cycle" уже полностью выражено самим DELETE-запросом на конкретный
trade cycle) — точное решение фиксируется в design-фазе Change 2. Требуется **только текстовая** правка
prose в `abi-position-management-api` spec ("full remainder" уточняется как "remainder принадлежащий
именно этому trade cycle").

**Обязательные тесты.**
- Single-owner: полностью регрессионные — поведение байт-в-байт как сегодня.
- Multi-owner (синтетические фикстуры, как в Change 1): close cycle A не отправляет reduceOnly qty
  больше своего `cumulative_filled_qty`; cycle B остаётся `applied`/live и его владение scope
  сохраняется.
- Close cycle с entry-ордером, всё ещё `PartiallyFilled` на момент запроса close: close сначала
  терминализирует entry-ордер (cancel+confirm), только потом резолвит финальный `cumulative_filled_qty`
  и закрывает ровно эту величину.
- Clamp-логика: расхождение resolved quantity vs. live остаток в пределах допуска → используется живой
  остаток; расхождение за пределами допуска → fail closed с конкретным кодом, никакого clamp.
- `avg_execution_price` этого cycle и соседних не изменяются в результате close.
- Existing `closeApplicationService.test.ts` регрессия — без изменений в assertions single-owner кейсов.

**Зависит от.** Change 1.

**Состояние после.** Close готов к multi-owner и материализует quantity ownership boundary из Change 1
(Runtime relative intent → ABI absolute quantity), но production не может создать multi-owner scope до
Change 5 — поведение в проде идентично сегодняшнему.

**Осознанно вне scope.** Произвольный partial close (V1 — full close only); mutable durable owned
remainder (не нужен, пока close full-close-only); детальный wire DTO relative-intent контракта —
решается внутри самого Change 2, не в master-plan; отмена/cancel pair-owned protection-ордеров при
close (это придёт в Change 8, когда такие ордера появятся).

---

### Change 3 — `abi-pair-scoped-open-position-resolution-v1`

**Цель.** Архитектурная идея №2 — open-position pair-scoped на основе virtual exposure конкретного
trade cycle, а не агрегированной физической позиции, с учётом того, что собственный entry-ордер cycle
может ещё не быть терминальным (partial fill, живой). **Wire-контракт не меняется**: ответ
`GET .../open-position` по-прежнему содержит только `position_open`/`first_fill_at_ms`/
`average_entry_price` (`src/domain/openPositionApi.ts:4-14`) — никакой quantity/size-поле не
добавляется.

**Уточнение роли `first_fill_at_ms` (после ревизии v4).** Это поле нужно ровно для одной цели:
Runtime передаёт его Strategy Engine по open-trade ветке, чтобы Engine определил стратегическую
свечу, в которой началась сделка. Оно не нужно для ownership quantity, close, protection или virtual
exposure accounting — это уже решено в Change 1 (там оно намеренно не вводится как ABI-internal
durable факт). **Change 3 — единственное место в программе, которое должно исследовать и решить**,
какое минимально достаточное own-order/execution evidence (не обязательно ABI-шное время первого
наблюдения fill, которое может отставать от границы следующей strategy bar) даёт корректную entry-bar
identity для этого wire-поля при multi-owner scope. Точность timestamp ради точности как
самостоятельная цель не требуется — требование системного уровня — корректно идентифицировать
entry strategy bar, не более и не менее.

**Что меняется.** `OpenPositionResolutionService.determine()`
(`src/services/openPosition/openPositionResolutionService.ts:101-140`):
- `first_fill_at_ms` для ответа этого cycle сурсится из own-order/execution evidence, которое Change 3
  сам определит как минимально достаточное для entry-bar identity (см. выше) — не обязательно из
  нового durable ABI-поля; Change 1 такого поля не вводит.
- `average_entry_price` сурсится из `cumulative_filled_qty`/`avg_execution_price`
  (`early_execution_observation`, формализованного Change 1), если собственный entry-ордер cycle уже
  `isFillFactFinal`; если ещё нет (живой/partial), сервис выполняет **целевой refresh** — переспрашивает
  собственный ордер этого cycle (переиспользуя существующий query/decode из `packageConfirmation.ts`,
  не изобретая новый механизм) и отвечает актуальным cumulative avgPrice. Это новая
  под-ответственность сервиса по сравнению с сегодняшним "всегда один live query агрегированной
  позиции".
- Live-запрос агрегированной позиции (`queryPositionForInstrument`) сохраняется, но переопределяется
  как **sanity-check существования и стороны** ("aggregate exists, side matches, size ≥
  `cumulative_filled_qty` этого cycle в пределах допуска"), а не как источник истины по цене/времени
  входа. Quantity-факты используются здесь **только** для sanity-check, наружу в ответе не попадают.

**Какие инварианты отменяются/заменяются.**
- open-position-resolution spec L166-177 (side-match — "plausibility check, не proof of attribution")
  — сохраняется как sanity-слой, но перестаёт быть единственной проверкой.
- L193-199 ("avgPrice/first_fill sourced напрямую из live row, never estimated") — заменяется:
  при единственном owner источник фактически тот же (совпадает), при множественном — обязателен
  собственный источник per-cycle, т.к. агрегированная Bybit-позиция физически не может отдать
  раздельные avgPrice/first-fill на владельца.

**Новые инварианты.** "Ответ open-position для cycle отражает `average_entry_price`/`first_fill_at_ms`
именно этого cycle, независимо от того, сколько ещё активных cycles делят тот же physical scope, и
независимо от того, терминализирован ли уже собственный entry-ордер cycle. Ответ никогда не содержит и
не подразумевает per-cycle quantity — это исключительно внутреннее понятие."

**Затрагиваемые слои.** `src/services/openPosition/openPositionResolutionService.ts` (новая
зависимость на query/decode-примитивы из `packageConfirmation.ts` для refresh-пути; возможно новая
логика определения entry-bar evidence). Не трогает routes/DTO слой (`src/routes/openPositionRoutes.ts`,
`src/domain/openPositionApi.ts`) — форма ответа идентична, поле quantity туда не добавляется.

**HTTP-контракты.** `GET .../open-position` — схема ответа не меняется. Текстовая правка prose в
`abi-open-position-lookup-api` (пояснение, что `average_entry_price`/`first_fill_at_ms` относятся к доле
этого trade cycle).

**Обязательные тесты.**
- Single-owner регрессия: значения идентичны сегодняшним (aggregate == собственная доля).
- Multi-owner (синтетические фикстуры): два cycle одной стороны на одном scope получают **разные**
  корректные `average_entry_price`/`first_fill_at_ms`, соответствующие их собственным ордерам, а не общей
  агрегированной позиции.
- Cycle с ещё живым (`PartiallyFilled`) собственным entry-ордером: `GET open-position` вызывает
  refresh-путь и отвечает актуальным `average_entry_price`, а не устаревшим значением из записи.
- Response DTO-тест подтверждает отсутствие quantity-поля в сериализованном ответе (защита от будущего
  случайного расширения публичного контракта).
- Sanity-check срабатывает: если aggregate meaningfully не согласуется с суммой quantity-полей —
  fail closed (internal_error либо новый код), не тихая деградация.
- Отдельный тест-набор на корректность entry-bar evidence при multi-owner scope (конкретная форма
  определяется в design-фазе Change 3).

**Зависит от.** Change 1.

**Состояние после.** Open-position готов к multi-owner и к живому partial-fill; в проде поведение
идентично сегодняшнему до Change 5.

**Осознанно вне scope.** Любое расширение wire-контракта `GET .../open-position` (quantity-поле туда не
добавляется ни в этом change, ни позже в рамках этой программы). Изменение error-таксономии
`abi-open-position-lookup-api` сверх уже существующей (кроме, возможно, нового кода на явный
drift-случай — решается как часть §6 рисков).

---

> **Примечание к ревизии v4.** Правки выше применены только к Change 1–3 по прямому запросу. Changes
> 4–8 ниже всё ещё написаны в терминах v3 (`remaining_quantity` как mutable поле,
> `first_fill_at_ms`/`physical_side` как поля Change 1, `VirtualExposure`-тип, ранняя эволюция
> `byScope` внутри Change 1) и требуют отдельного согласующего прохода, прежде чем на них можно
> опираться буквально. Архитектурные решения v4 (quantity ownership boundary, full-close-only V1,
> отсутствие `first_fill_at_ms`/mutable remainder в Change 1) остаются в силе и для них — реализация
> Changes 4–8 не должна опираться на поля, которые Change 1 больше не вводит.

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
Собственный order query recovery уже сегодня возвращает `cumExecQty`/`avgPrice` — это легитимный
дополнительный refresh-путь для `cumulative_filled_quantity`/`average_entry_price` записи, тот же
механизм, что и в Change 1/3, без второй реализации.

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

### Change 5 — `abi-same-side-virtual-exposure-ownership-v1` (Activation #1 — "активация базового ownership")

**Цель.** Архитектурная идея №1 — заменить physical-scope exclusivity на virtual same-side exposure
ownership. Это единственный change из первой пятёрки, реально включающий multi-owner в production.

**Что меняется.**
- `EntryPackageApplicationService.createOrder()` (`entryPackageApplicationService.ts:268-294`): claim-
  проверка меняется с "owner существует и это не та же пара → conflict" на "у scope уже есть активная
  сторона, отличная от стороны этой команды → conflict; иначе — присоединиться как дополнительный owner
  этой стороны" (используя структуру из Change 1).
- Release generalized: durable close одного cycle убирает только его запись из owner-множества
  (реализовано в Change 2/1); сторона scope очищается, когда множество опустело.
- **Неразделимый safety-компаньон**: малый guard в `ProtectionApplicationService` — если у scope больше
  одного активного owner, `PUT .../protection` для любого из них **fail closed** (новый явный код,
  например `shared_scope_protection_unsupported`) до прихода Change 8. Это обязано ехать в этом же
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
- Protection для scope с >1 owner фейлится закрыто (временный инвариант, снимается только в Change 8).

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
  multi-owner активацией, включая partial-fill сценарий).
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
open-position уже корректны для этого случая, включая живой partial fill; protection временно
заблокирован для shared scope до Change 8.

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

### Change 7 — `abi-pair-owned-protection-execution-v1` (production-инертен — guard НЕ снимается)

**Цель.** Построить и полностью протестировать pair-owned reduce-only conditional exit orders lifecycle
для protection, **не активируя** его в production для shared scope — guard из Change 5 остаётся в силе.
Это тот же принцип, что уже применён к Changes 2/3/4/6: реализация готова и протестирована заранее,
активация — отдельным, последним шагом (Change 8).

**Что меняется.**
- Добавляется (но не подключается к production-пути `PUT .../protection` для shared scope) полный
  create/update/cancel/confirm lifecycle pair-owned stop/take-ордеров через примитивы из Change 6, с
  qty = `remaining_quantity` (уже терминализованный, per Change 1/2).
- Bounded confirmation для protection-ордеров зеркалит существующую bounded confirmation для entry
  (`packageConfirmation.ts`).
- `ProtectionApplicationService` получает эту lifecycle-реализацию как готовый, полностью протестированный
  code path, но **выбор**, каким путём обслуживать конкретный `PUT .../protection` (старый
  `setTradingStop` для single-owner, guard-отказ для multi-owner), не меняется — guard из Change 5 всё
  ещё активен для multi-owner scope. Явно фиксируется: этот change **сознательно не активирует**
  multi-owner protection в production.

**Какие инварианты отменяются/заменяются.** Ни один production-наблюдаемый инвариант не меняется —
только появляется новый, полностью протестированный, но ещё не подключённый к production-decision code
path.

**Новые инварианты.**
- Protection-ордер lifecycle (create/confirm/cancel/replace) для одного cycle корректен и независим от
  соседних cycles на том же physical scope — доказано тестами, но ещё не наблюдаемо в production.
- Bounded confirmation для protection-ордеров: fail closed при неоднозначности, зеркалит entry-package.

**Затрагиваемые слои.** `src/services/protection/protectionApplicationService.ts` (добавляется новый
lifecycle, существующий production-decision path не меняется). Не расширяет `CloseApplicationService` —
это Change 8.

**HTTP-контракты.** `PUT .../protection` — форма и **наблюдаемое поведение** не меняются вообще (в т.ч.
`shared_scope_protection_unsupported` из Change 5 продолжает возвращаться для multi-owner scope).

**Обязательные тесты.**
- Два same-side cycle с разными stop/take на одном physical scope (тест обращается к lifecycle
  напрямую, минуя production-decision path `ProtectionApplicationService`, если тот ещё не переключён):
  оба подтверждаются независимо, каждый — со своим orderLinkId.
- Bybit reject/partial-confirm сценарии для conditional-ордеров — bounded retry, fail closed при
  неоднозначности.
- Регрессия `protectionApplicationService.test.ts` для **существующего** production-decision path —
  байт-в-байт без изменений (включая guard-отказ для multi-owner scope).

**Зависит от.** Change 6 (identity/data model), Change 5 (нужны реально существующие multi-owner scopes
для интеграционных тестов lifecycle, хотя production-decision path их ещё не использует), Change 3
(lifecycle делегирует в open-position-resolution).

**Состояние после.** Полный pair-owned protection lifecycle реализован и протестирован; production-
поведение `PUT .../protection` не изменилось — multi-owner scope по-прежнему получает guard-отказ.

**Осознанно вне scope.** Подключение lifecycle к production-decision path и снятие guard (Change 8);
интеграция с close (Change 8); поддержка opposite-side.

---

### Change 8 — `abi-pair-owned-protection-close-cleanup-v1` (Activation #2 — снимает guard)

**Цель.** Завершить redesign protection: `CloseApplicationService` при закрытии cycle отменяет его
собственные protection-ордера как часть терминального перехода, и **только после этого** guard из
Change 5 снимается — `PUT .../protection` для multi-owner scope становится production-active через
lifecycle из Change 7. Это единственный change во всей protection-цепочке, меняющий production-
наблюдаемое поведение — то же место в последовательности, что Change 5 занимает для базового ownership.

**Что меняется.**
- `CloseApplicationService` расширяется: при durable close cycle отменяет (cancel + bounded confirm, тот
  же паттерн, что уже применяется к entry-ордеру в close-execution) его собственные `stop`/`take`
  conditional-ордера (по данным из Change 6) до/как часть закрытия `remaining_quantity`.
  `terminal_closed` теперь гейтится на **оба** постусловия: (а) live position уменьшена ровно на
  `remaining_quantity` этого cycle, (б) собственные protection-ордера этого cycle неактивны (отменены
  или уже терминальны).
- `ProtectionApplicationService`: guard `shared_scope_protection_unsupported` из Change 5 снимается —
  production-decision path переключается на lifecycle из Change 7 для multi-owner scope.

**Какие инварианты отменяются/заменяются.** Постусловие close-execution ("terminal_closed требует
подтверждённого zero position size AND no attributable active entry-order remainder") расширяется:
дополнительно требуется отсутствие live protection-ордеров этого cycle. Временный инвариант Change 5
("protection для scope с >1 owner фейлится закрыто") — снимается.

**Новые инварианты.** "Close cycle гарантированно не оставляет собственных protection-ордеров висящими
на бирже после durable close — ни при single-owner, ни при multi-owner scope." "`PUT .../protection` для
multi-owner scope корректно и независимо обслуживает каждый cycle через pair-owned conditional-ордера."

**Затрагиваемые слои.** `src/services/close/closeApplicationService.ts` (дополнение, не рефакторинг
основной логики close из Change 2), `src/services/protection/protectionApplicationService.ts` (снятие
guard — переключение production-decision path на lifecycle из Change 7).

**HTTP-контракты.** `DELETE .../open-position`, `PUT .../protection` — форма не меняется.
`shared_scope_protection_unsupported` больше не возвращается (contract narrows back to fewer error
cases — обратно совместимо, просто меньше 4xx-путей).

**Обязательные тесты.**
- Close одного cycle отменяет именно его protection-ордера, не трогая ордера соседнего same-side cycle.
- `terminal_closed` не достигается, пока protection-ордера этого cycle ещё живы/неоднозначны (fail
  closed на неоднозначности отмены, зеркалит существующий паттерн cancel-entry-order-first).
- После снятия guard: два same-side cycle с разными stop/take на одном scope оба обслуживаются
  независимо через `PUT .../protection` (интеграционный тест production-decision path, не только
  lifecycle напрямую, как в Change 7).
- Single-owner регрессия (в зависимости от решения риска §6.7 — либо байт-в-байт то же поведение через
  fallback на `setTradingStop`, либо явно новое поведение через conditional-ордера, задокументированное
  как намеренное изменение).
- Регрессия `closeApplicationService.test.ts` для scope без активных protection-ордеров (no-op путь).

**Зависит от.** Change 7 (нужен готовый lifecycle), Change 2 (расширяет уже существующую pair-scoped
close-логику).

**Примечание по объёму.** Если в ходе design-фазы Change 6/7 выяснится, что cancellation-логика
тривиальна, Change 8 можно слить с Change 7 в один change — но правило "guard снимается только после
того, как close уже умеет neutralize protection-ордера" при слиянии сохраняется как внутренний порядок
шагов этого объединённого change, а не отменяется. По умолчанию держим отдельно как более безопасный и
проще review-ируемый вариант.

**Состояние после.** Полная реализация всех четырёх целевых архитектурных идей пользователя; long+long и
short+short полностью и честно поддержаны, включая независимую protection с корректной уборкой при close;
long+short остаётся запрещённым, пока жива противоположная exposure. Ни один из applied changes 1–8 не
проходил через небезопасное промежуточное production-состояние.

**Осознанно вне scope.** Полноценный portfolio/netting engine; hedge mode; opposite-side coexistence.

---

## 4. Dependency graph

```
Change 1 (foundation: exposure state)
   ├──> Change 2 (close, owner-aware)         ──┐
   ├──> Change 3 (open-position, owner-aware) ──┤
   └──> Change 4 (recovery, owner-aware)      ──┤
                                                 ├──> Change 5 (Activation #1: same-side ownership + protection guard)
                              (2,3 напрямую;     │        │
                               4 — по соглас-    │        ├──> Change 6 (foundation: protection identity/state)
                               ованности)        │        │        │
                                                  │        │        └──> Change 7 (protection lifecycle, guard НЕ снимается)
                                                  │        │                 │
                                                  │        │                 └──> Change 8 (close cleanup + Activation #2: снимает guard)
                                                  │        │                          ▲
                                                  └────────┴──────────────────────────┘ (Change 8 также зависит от Change 2)
```

Текстово: 1 → {2, 3, 4} (параллельно возможны) → 5 (требует 1,2,3, желательно 4; **Activation #1**) →
6 (требует 1, может идти параллельно с 2/3/4/5) → 7 (требует 6, 5, 3; production-инертен) →
8 (требует 7, 2; **Activation #2**).

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
- **`protection-execution`** — **изменяется четырежды**: малое дополнение в Change 5 (guard), additive
  foundation в Change 6 (без изменения поведения), новый lifecycle в Change 7 (production-инертно,
  наблюдаемое поведение не меняется), и наконец практическая замена production-decision path в Change 8
  (guard снимается).
- **`entry-cycle-recovery-resolution`** — **изменяется** Change 4 (атрибуционная логика), остальное
  (dual-query bounded retry, legacy pending_action guard, read-only гарантия) сохраняется.
- **`entry-package-execution`** — **дополняется** Change 1 (новые additive-поля/их заполнение,
  переиспользующее существующие `cumExecQty`/`avgPrice` точки чтения в `packageConfirmation.ts`) и
  Change 6 (новые orderLinkId-роли), основной текст (order identity, create/cancel semantics,
  confirmation) не меняется.
- **`abi-position-management-api`, `abi-open-position-lookup-api`** — **только текстовые правки** prose
  (без изменения wire-схемы) в Changes 2, 3, 5, 8 — пояснить, что значения относятся к доле cycle, а не к
  физической позиции целиком; при необходимости — добавить новые коды ошибок (см. риск). Явно
  зафиксировать, что `GET .../open-position` не приобретает quantity-поле ни на одном шаге этой
  программы.
- **`exchange-instrument-identity`, `container-runtime`** — не затрагиваются.
- Отдельно, вне этой программы: **`abi-entry-package-exchange-canonical-confirmation-v1`** реализован,
  но не заархивирован в `openspec/changes/archive/` — рекомендуется провести housekeeping-архивацию
  до старта этой программы, чтобы baseline специй был чистым для дифов новых changes.

---

## 6. Риски и спорные архитектурные решения (закрыть до apply)

1. **Механизм обновления `cumulative_filled_quantity`/`average_entry_price` до терминализации.**
   Источник данных (`item.cumExecQty`/`item.avgPrice`) уже подтверждён кодом (`packageConfirmation.ts:134,
   380-381`) — риска "а есть ли вообще такие поля у Bybit" больше нет. Открыт design-вопрос: персистить
   явный `entry_order_terminal`-флаг на записи (синхронизируемый при каждом наблюдении) или всегда
   переспрашивать терминальность on-demand через `classifyEntryOrderTerminality`-подобную логику, когда
   потребителю (close/open-position/protection) нужна свежая величина. Рекомендация — on-demand
   переспрос (меньше состояния для поддержания консистентным), решение фиксируется в design-фазе Change 1.

2. **Политика допуска дрейфа и clamp.** `sum(remaining_quantity активных same-side owners)` может
   разойтись с живым агрегированным размером позиции (округления qtyStep у разных входов, ручное
   вмешательство, частичные fills). Правило теперь однозначно (см. Change 2): clamp допустим только в
   пределах заранее определённого малого допуска на биржевое округление; любое расхождение за пределами
   допуска — fail closed с явным "требуется reconciliation" кодом, никогда молчаливый clamp вниз (clamp
   мог бы срезать чужую, соседнюю по scope, exposure). Конкретная величина допуска фиксируется в
   design-фазе Change 2.

3. **Таксономия ошибок.** Opposite-side rejection, protection-guard для shared scope и новый
   reconciliation-required код для close можно отдавать как существующий `internal_error` (не меняя
   "закрытый словарь" ошибок) либо ввести точные новые коды (лучше для наблюдаемости/дебага, но формально
   это additive-изменение текста closed-vocabulary таблиц в
   `abi-position-management-api`/`abi-entry-package-api`). Нужно решение до Change 5.

4. **Технические детали conditional-ордеров Bybit V5** для Change 6/7 (triggerBy, типы Stop/TakeProfit,
   корректное сосуществование нескольких reduceOnly conditional ордеров на один symbol в one-way mode)
   — рекомендуется отдельный technical spike перед написанием proposal Change 6.

5. **Observability пробел.** Сегодня нет метрик/событий, различающих scope contention или multi-owner
   состояние (`src/observability/events.ts` не имеет соответствующих полей). Без добавления полей
   (owner count, side, drift, terminal-refresh-события) новый инвариант станет операционно невидимым —
   рекомендуется добавить как часть Change 1 (структура) и Change 5 (события активации).

6. **Философский разворот в close (Change 2).** Явно зафиксировать как осознанное решение: до сих пор
   close принципиально не доверял ABI-recorded количествам именно чтобы избежать дрейфа; теперь для
   multi-owner случая это единственный физически возможный источник, и только после верификации
   терминальности собственного entry-ордера cycle. Это решение нужно явно одобрить, а не оставлять
   неявным побочным эффектом.

7. **Совместимость protection в single-owner случае (Change 7/8).** Нужно решить: сохраняется ли
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
    не заранее; правило "guard снимается только после close-cleanup" сохраняется при любом слиянии.

---

## 7. Финальный рекомендуемый порядок реализации и smoke-verification

0. **Housekeeping (вне программы):** заархивировать `abi-entry-package-exchange-canonical-confirmation-v1`
   в `openspec/changes/archive/`, чтобы baseline специй был чист.
1. **Закрыть риски §6** (механизм refresh для cumulative_filled_quantity/avgPrice, точная величина
   допуска дрейфа/clamp, таксономия ошибок, conditional-order детали, single-owner fallback в protection)
   — до написания первого proposal.
2. **Change 1** → apply → регрессия всего существующего test suite (ожидается 0 поведенческих изменений)
   → smoke: restart процесса на существующих данных, подтвердить, что single-owner scopes резолвятся
   идентично; отдельно smoke на реальном частичном fill на Bybit Demo — убедиться, что
   `cumulative_filled_quantity` действительно продолжает расти после первого partial-fill наблюдения.
3. **Change 2** → apply → синтетические multi-owner и partial-fill тесты + полная регрессия close →
   smoke: реальный close на Bybit Demo для обычного single-cycle сценария, побайтово то же поведение,
   что до change.
4. **Change 3** → apply → аналогично → smoke: `GET open-position` на реальной Demo-позиции, включая
   момент, когда entry-ордер ещё partial — `average_entry_price` в ответе актуален, а не устаревший;
   ответ по-прежнему не содержит quantity-поля.
5. **Change 4** → apply → smoke: убить/перезапустить процесс посреди активного trade cycle (в т.ч. с
   partial fill) на Demo, подтвердить recovery-state не изменился относительно baseline.
6. **Change 5 (Activation #1)** → apply → это шаг с наибольшим риском живого поведения для базового
   ownership → smoke на Bybit Demo: два same-side entry-package на одном symbol от разных trade cycles
   оба успешно создаются и сосуществуют; третья opposite-side попытка отклоняется; `PUT protection` на
   любом из двух active owners отклоняется новым guard-кодом; close одного cycle уменьшает физическую
   позицию строго на его долю, второй cycle остаётся нетронутым (позиция и его открытость).
7. **Change 6** → apply → smoke: identity-генерация и replay protection-полей работают изолированно;
   `PUT .../protection` ведёт себя байт-в-байт как до этого change.
8. **Change 7** → apply → smoke: lifecycle protection-ордеров корректно работает при прямом вызове (не
   через production `PUT .../protection`); production-путь `PUT .../protection` для multi-owner scope
   по-прежнему возвращает guard-отказ — явно проверить, что ничего не изменилось для пользователя.
9. **Change 8 (Activation #2)** → apply → smoke на Bybit Demo: guard снят; у двух same-side cycles
   независимые stop/take conditional-ордера через `PUT .../protection`; close одного cycle отменяет
   именно его conditional-ордера, не трогая ордера второго; `terminal_closed` достигается только после
   обоих постусловий.

Каждый шаг — самостоятельно принимаемый OpenSpec change с собственным proposal/design/tasks, отдельным
review и отдельным apply — согласно ограничению не смешивать несколько архитектурных ответственностей
в одном change.
