# Мастер-план: от position-scope-exclusivity к virtual same-side exposure ownership

> Это мастер-план последовательности будущих OpenSpec changes (GitHub Issue #3: "Backlog: virtual
> position ledger for shared same-symbol exposure"). Сам план не является OpenSpec change и ничего не
> реализует — каждый пункт раздела 2 должен быть оформлен как отдельный OpenSpec change (proposal/
> design/tasks) со своим review и apply.

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
   на cycle. Это неизбежная точка разрыва инварианта, независимо от того, как строить virtual ledger.

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

**Не заводим новый durable store.** Расширяем `EntryPackageExecutionRecord` двумя additive-полями
(`physical_side`, `owned_quantity`, оба заполняются из данных **собственного ордера cycle**, а не из
агрегированной позиции — см. Change 1) и эволюционируем `byScope` из `Map<scope, record>` в
`Map<scope, {side, owners: Map<pairKey, ownedQuantity>}>` — производный индекс, восстанавливаемый при
replay ровно как сегодня. Это прямое продолжение уже сформулированного в спеке принципа "scope ownership
derived from existing durable correlation state, not a new store" (position-scope-exclusivity spec L35-46).
Отдельный "ledger" как самостоятельный источник истины не нужен и добавил бы второй source of truth
без выгоды.

### Архитектурное решение: protection

Сравнены два варианта:

- **A. Position-level protection с виртуальной координацией** (агрегированный/усреднённый stop-take на
  всю физическую позицию). Отклонён: физически невозможно честно обслужить два разных желаемых
  stop/take одновременно через один `/v5/position/trading-stop`; закрытие одного cycle требует
  пересчитывать/переотправлять общий stop для оставшихся; нарушает уже существующий инвариант
  "exact numeric match to accepted values" per pair (protection-execution spec L75-119).
- **B. Pair-owned reduce-only conditional exit orders** (собственный stop-order и take-order на cycle,
  reduceOnly, qty = `owned_quantity`, orderLinkId по уже существующей схеме
  `entryPackageOrderIdentity.ts`). Выбран как архитектурно верный — единственный вариант с честной
  per-cycle изоляцией, переиспользует уже отработанные паттерны (order identity, bounded confirmation,
  reduceOnly semantics, которые уже использует close-execution).

Вариант B **не** включается в тот же change, что базовый virtual ownership (см. ниже) — это отдельный,
самостоятельно большой рефакторинг `protection-execution`. До его прихода вводится временный fail-closed
guard (см. Change 5).

### Нужен ли отдельный "foundation" change до изменения execution semantics?

**Да.** Он выделен в Change 1: только эволюция данных (record fields + производный индекс), без изменения
поведения claim/close/open-position/protection. Это позволяет протестировать сложную replay/durability
логику отдельно от изменения бизнес-политики, и даёт последующим шагам стабильный фундамент.

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
- Virtual exposure состояние — additive-поля в существующем `EntryPackageExecutionRecord` +
  производный многовладельческий scope-индекс. Никакого нового durable store.
- `open-position` для конкретного cycle отвечает исходя из **собственного** owned_quantity/avgPrice
  этого cycle (из данных его собственного ордера), а не из агрегированной Bybit-позиции — агрегированный
  live-запрос остаётся только как sanity-проверка существования/стороны.
- `close` для конкретного cycle уменьшает физическую позицию ровно на `owned_quantity` этого cycle
  (reduceOnly), а не закрывает весь physical size — при единственном владельце поведение идентично
  сегодняшнему (используется live aggregate size, как раньше, для устранения дрейфа).
- `protection` до отдельного redesign-change явно блокируется (fail closed) для scope с >1 активным
  owner; сам redesign переводит protection на pair-owned reduceOnly conditional stop/take-ордера с
  собственными orderLinkId на cycle.
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
| 3 | `abi-pair-scoped-open-position-resolution-v1` | `open-position-resolution` | Consumer prep (owner-aware) |
| 4 | `abi-entry-cycle-recovery-attribution-v1` | `entry-cycle-recovery-resolution` | Consumer prep (owner-aware) |
| 5 | `abi-same-side-virtual-exposure-ownership-v1` | супersedes `position-scope-exclusivity`; малый guard в `protection-execution` | **Activation** — центральный change |
| 6 | `abi-pair-owned-protection-execution-v1` | `protection-execution` (+ малое расширение close-execution) | Execution redesign |

Changes 2, 3, 4 формально зависят только от Change 1 и **не зависят друг от друга** — их можно вести
параллельно/в любом порядке. Ниже дан рекомендованный линейный порядок для одной команды.

---

## 3. Детали по каждому change

### Change 1 — `abi-virtual-exposure-state-foundation-v1`

**Цель.** Дать данным способность представлять нескольких owners одного physical scope одной стороны,
не меняя ничьё наблюдаемое поведение.

**Что меняется.**
- `EntryPackageExecutionRecord` (`src/correlation/entryPackageExecutionRecord.ts`): два новых
  additive-поля — `physical_side: "long" | "short" | null` (заполняется при первом бинде, из
  `desired_entry.side`) и `owned_quantity: string | null` (exact-decimal; заполняется/обновляется на
  confirmation-шаге из **данных собственного ордера cycle** — исполненного qty этого конкретного ордера,
  не из агрегированной позиции; конкретный источник в Bybit-ответе — `cumExecQty`/аналог с
  order-realtime/order-history — требует технического уточнения, см. риски).
- `EntryPackageCorrelationRepository`: `byScope` эволюционирует из `Map<scopeKey, record>` в
  `Map<scopeKey, { side; owners: Map<pairKey, { record; ownedQuantity }> }>`. `applyScopeClaimOnWrite`
  и `rebuildScopeIndexFromReplay` (`entryPackageCorrelationRepository.ts:179-257`) переписываются под
  новую форму, но вызывающий код (claim-check в entry-package) продолжает получать поведенчески то же
  самое — "один активный owner на scope" (политика не меняется, меняется только представление).
  Существующий `findOwnerByScope()` сохраняется как совместимая обёртка; добавляется новый
  `findOwnersByScope()` для будущих потребителей.
- Возможно новый тип `src/domain/virtualExposure.ts` (`ScopeOwnership`, аналог `PositionScope`).

**Какие инварианты отменяются.** Ни один поведенческий инвариант не отменяется — только внутреннее
представление данных (`byScope` меняет форму с "один владелец" на "структура, способная хранить многих").

**Новые инварианты.**
- Производный индекс восстанавливается из replay детерминированно для N совладельцев одной стороны
  (расширение существующей "two-phase replay, judged on final state only").
- Смешанная сторона в финальном replay-состоянии одного scope — по-прежнему hard-fail readiness (это
  генуинный сигнал повреждения данных).

**Затрагиваемые слои.** `src/correlation/entryPackageExecutionRecord.ts`,
`src/correlation/entryPackageCorrelationRepository.ts`, возможно `src/domain/`. Не затрагивает
`services/close`, `services/openPosition`, `services/protection`, `services/entryPackage`
(claim-логика не меняется — расширяется только позже).

**HTTP-контракты.** Не меняются.

**Обязательные тесты.**
- Replay восстанавливает multi-owner структуру из **синтетически подготовленных** (сидированных
  напрямую в JSONL/через тестовый API репозитория) записей с одной стороной — до Change 5 production-код
  никогда сам такую ситуацию не создаст, поэтому тест обязан строить её напрямую.
- Backward-compat: replay старых записей без новых полей (default/derive без падения).
- Все существующие тесты `entryPackageCorrelationRepository.test.ts` проходят без изменений
  наблюдаемого поведения.
- Mixed-side replay всё ещё fail-closed.

**Зависит от.** Ничего (первый шаг).

**Состояние после.** Данные готовы представлять multi-owner; поведение системы идентично сегодняшнему;
`position-scope-exclusivity` продолжает управлять фактическим поведением без изменений.

**Осознанно вне scope.** Любое изменение claim-политики, close, open-position, protection.

---

### Change 2 — `abi-pair-scoped-close-execution-v1`

**Цель.** Реализовать архитектурную идею №3 — close конкретного cycle через pair quantity, а не через
закрытие всей физической позиции — заранее, безопасно, под ветвлением "если owner один — старое
поведение".

**Что меняется.** `CloseApplicationService` (`src/services/close/closeApplicationService.ts:153-179`):
- Если у scope ровно один активный owner — поведение **не меняется**: reduceOnly qty = live aggregate
  `row.size` (как сегодня, максимально доверяя exchange, не ABI-шным числам — сохраняем текущую
  философию "never trust ABI-recorded quantity" для этого случая).
- Если owners > 1 — reduceOnly qty = `owned_quantity` этого cycle, **clamped** сверху живым остатком
  агрегированной позиции (защита от over-close/reject). Если `owned_quantity` не заполнен/сумма
  owned_quantity заметно расходится с live aggregate size за пределами допуска — fail closed (см. риск
  о политике допуска дрейфа).
- Release-семантика уточняется: при durable close этого cycle из `owners`-множества scope убирается
  только его запись; сторона (`side`) scope очищается лишь когда множество owners становится пустым
  (сегодняшнее "release = весь scope" остаётся верным при единственном owner).

**Какие инварианты отменяются/заменяются.** close-execution spec L110-124 ("close size сурсится
исключительно из live aggregate query, никогда из ABI-recorded/calculated quantity") — заменяется на
"при единственном owner — как раньше; при множественном — обязательно из ABI-recorded owned_quantity,
т.к. exchange физически не знает про доли между cycles". Это единственный настоящий разворот философии
в этой программе; квалифицируется отдельно как риск (см. §6).

**Новые инварианты.** "Close уменьшает физическую позицию ровно на долю closing cycle, оставляя чужие
доли нетронутыми"; "release из owner-множества не подразумевает release всего scope, пока есть другие
активные owners".

**Затрагиваемые слои.** `src/services/close/closeApplicationService.ts`,
`src/correlation/entryPackageCorrelationRepository.ts` (partial-release helper). Domain: возможно
`src/domain/positionScope.ts` для новых типов.

**HTTP-контракты.** `DELETE .../open-position` — форма (пустое тело, тот же response) не меняется.
Требуется **только текстовая** правка prose в `abi-position-management-api` spec ("full remainder"
уточняется как "remainder принадлежащий именно этому trade cycle").

**Обязательные тесты.**
- Single-owner: полностью регрессионные — поведение байт-в-байт как сегодня.
- Multi-owner (синтетические фикстуры, как в Change 1): close cycle A не отправляет reduceOnly qty
  больше `owned_quantity`; cycle B остаётся `applied`/live и его владение scope сохраняется.
- Clamp-логика: `owned_quantity` больше живого остатка → используется живой остаток, не превышение.
- Drift-за-пределами-допуска → fail closed, конкретный код ошибки.
- Existing `closeApplicationService.test.ts` регрессия — без изменений в assertions single-owner кейсов.

**Зависит от.** Change 1.

**Состояние после.** Close готов к multi-owner, но production не может создать multi-owner scope до
Change 5 — поведение в проде идентично сегодняшнему.

**Осознанно вне scope.** Отмена/cancel pair-owned protection-ордеров при close (это придёт в Change 6,
когда такие ордера появятся).

---

### Change 3 — `abi-pair-scoped-open-position-resolution-v1`

**Цель.** Архитектурная идея №2 — open-position pair-scoped на основе virtual exposure конкретного
trade cycle, а не агрегированной физической позиции.

**Что меняется.** `OpenPositionResolutionService.determine()`
(`src/services/openPosition/openPositionResolutionService.ts:101-140`):
- `size`/`average_entry_price`/`first_fill_at_ms` для ответа этого cycle сурсятся из **собственных**
  `owned_quantity` и данных собственного ордера этого cycle (не из агрегированной Bybit-позиции —
  инвариант spec L193-199 заменяется, см. ниже).
- Live-запрос агрегированной позиции (`queryPositionForInstrument`) сохраняется, но переопределяется
  как **sanity-check существования и стороны** ("aggregate exists, side matches, size ≥ owned_quantity
  этого cycle в пределах допуска"), а не как единственный источник истины по количеству/цене.

**Какие инварианты отменяются/заменяются.**
- open-position-resolution spec L166-177 (side-match — "plausibility check, не proof of attribution")
  — сохраняется как sanity-слой, но перестаёт быть единственной проверкой.
- L193-199 ("avgPrice/first_fill sourced напрямую из live row, never estimated") — заменяется:
  при единственном owner источник фактически тот же (совпадает), при множественном — обязателен
  собственный источник per-cycle, т.к. агрегированная Bybit-позиция физически не может отдать
  раздельные avgPrice на владельца.

**Новые инварианты.** "Ответ open-position для cycle отражает долю именно этого cycle, независимо от
того, сколько ещё активных cycles делят тот же physical scope."

**Затрагиваемые слои.** `src/services/openPosition/openPositionResolutionService.ts`. Не трогает
routes/DTO слой (`src/routes/openPositionRoutes.ts`, `src/domain/openPositionApi.ts`) — форма ответа
идентична.

**HTTP-контракты.** `GET .../open-position` — схема ответа не меняется. Текстовая правка prose в
`abi-open-position-lookup-api` (пояснение, что значения относятся к доле этого trade cycle).

**Обязательные тесты.**
- Single-owner регрессия: значения идентичны сегодняшним (aggregate == собственная доля).
- Multi-owner (синтетические фикстуры): два cycle одной стороны на одном scope получают **разные**
  корректные `average_entry_price`/`size`, соответствующие их собственным ордерам, а не общей
  агрегированной позиции.
- Sanity-check срабатывает: если aggregate meaningfully не согласуется с суммой owned_quantity —
  fail closed (internal_error либо новый код), не тихая деградация.

**Зависит от.** Change 1.

**Состояние после.** Open-position готов к multi-owner; в проде поведение идентично сегодняшнему до
Change 5.

**Осознанно вне scope.** Изменение error-таксономии `abi-open-position-lookup-api` сверх уже
существующей (кроме, возможно, нового кода на явный drift-случай — решается как часть §6 рисков).

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
  например `shared_scope_protection_unsupported`) до прихода Change 6. Это обязано ехать в этом же
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
- Protection для scope с >1 owner фейлится закрыто (временный инвариант, снимается Change 6).

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

**Осознанно вне scope.** Сам pair-owned protection redesign (Change 6); поддержка opposite-side
(намеренно остаётся запрещённой согласно требованию пользователя); любой netting/portfolio-движок.

---

### Change 6 — `abi-pair-owned-protection-execution-v1`

**Цель.** Архитектурная идея №4 — переосмыслить protection: заменить shared position-level protection
на pair-owned reduce-only conditional exit orders на cycle.

**Что меняется.**
- `ProtectionApplicationService` перестаёт вызывать `/v5/position/trading-stop` как основной механизм
  (или сохраняет его только для единственного случая single-owner scope — решение по совместимости,
  см. риск) и вместо этого создаёт/обновляет/отменяет собственные reduceOnly conditional
  stop-market/take-profit ордера для данного cycle, с `orderLinkId`, построенным по уже существующей
  схеме `entryPackageOrderIdentity.ts` (роли `"stop"`/`"take"` вместо `"entry"`).
- `CloseApplicationService` расширяется: при durable close cycle отменяет его собственные protection-
  ордера (чтобы не оставлять dangling reduceOnly ордера на бирже) — использует тот же паттерн
  cancel+confirm, что уже применяется к entry-ордеру в close-execution.
- Guard из Change 5 ("fail closed при >1 owner") снимается — заменяется реальной реализацией.

**Какие инварианты отменяются/заменяются.** protection-execution spec целиком (position-level
`setTradingStop`, "both legs together in a single write", read-back verification против агрегированной
позиции) заменяется на per-cycle conditional-order lifecycle (create/confirm/cancel/replace), аналогично
существующей entry-package confirmation-модели.

**Новые инварианты.**
- Protection каждого cycle полностью независим от protection любого другого cycle на том же physical
  scope.
- Close cycle гарантированно не оставляет собственных protection-ордеров висящими на бирже после
  durable close.
- Bounded confirmation для protection-ордеров зеркалит существующую bounded confirmation для entry
  (`packageConfirmation.ts`).

**Затрагиваемые слои.** `src/services/protection/protectionApplicationService.ts` (значительный
рефакторинг), `src/services/close/closeApplicationService.ts` (дополнение), `src/exchange/bybitAdapter.ts`
(новые методы: place/cancel conditional order, если ещё не покрыты существующим `createOrder`/
`cancelOrder`), `src/domain/entryPackageOrderIdentity.ts` (расширение ролей), correlation record —
возможно новые поля для хранения protection-ордеров cycle (order_link_id/order_id уже заняты entry —
нужны отдельные поля, например `stop_order_link_id`, `take_order_link_id`).

**HTTP-контракты.** `PUT .../protection` — форма не меняется (по-прежнему `stop_price`/`take_price`).
Убирается временный код `shared_scope_protection_unsupported`, введённый в Change 5 (contract narrows
back to fewer error cases — обратно совместимо, просто меньше 4xx-путей).

**Обязательные тесты.**
- Два same-side cycle с разными stop/take на одном physical scope: оба подтверждаются независимо,
  каждый — со своим orderLinkId.
- Close одного cycle отменяет именно его protection-ордера, не трогая ордера соседнего cycle.
- Single-owner регрессия (если сохраняется fallback на `setTradingStop` для этого случая — нужно решить,
  см. §6).
- Bybit reject/partial-confirm сценарии для conditional-ордеров — bounded retry, fail closed при
  неоднозначности (зеркалит существующие паттерны entry-package confirmation).
- Полная регрессия `protectionApplicationService.test.ts`, `closeApplicationService.test.ts` под новой
  моделью.

**Зависит от.** Change 5 (нужны реально существующие multi-owner scopes для полноценного теста), Change 2
(расширяет close).

**Состояние после.** Полная реализация всех четырёх целевых архитектурных идей пользователя; long+long и
short+short полностью и честно поддержаны, включая независимую protection; long+short остаётся
запрещённым, пока жива противоположная exposure.

**Осознанно вне scope.** Полноценный portfolio/netting engine; hedge mode; opposite-side coexistence;
динамический пересчёт protection на основе доли (например, trailing stop, синхронизированный между
cycles) — только независимая protection на cycle.

---

## 4. Dependency graph

```
Change 1 (foundation)
   ├──> Change 2 (close, owner-aware)         ──┐
   ├──> Change 3 (open-position, owner-aware) ──┤
   └──> Change 4 (recovery, owner-aware)      ──┤
                                                 ├──> Change 5 (activation: same-side ownership + protection guard)
                              (2,3 напрямую;     │        │
                               4 — по соглас-    │        └──> Change 6 (pair-owned protection redesign)
                               ованности)        │             (также зависит от Change 2)
                                                  │
```

Текстово: 1 → {2, 3, 4} (параллельно возможны) → 5 (требует 1,2,3, желательно 4) → 6 (требует 5 и 2).

---

## 5. Какие существующие OpenSpecs должны быть изменены/superseded/удалены

- **`position-scope-exclusivity`** — **superseded** Change 5. Центральный инвариант заменяется. Спеку не
  удаляем физически (история), но переводим в архивный/historical статус, а действующей capability
  становится новая (`virtual-exposure-ownership` или аналог).
- **`open-position-resolution`** — **изменяется** Change 3 (два конкретных требования заменяются, см.
  Change 3 выше), остальное сохраняется.
- **`close-execution`** — **изменяется** Change 2 (ключевой разворот в источнике qty), остальное
  (cancel-entry-order-first, unsupported_exchange_scope, идемпотентность) сохраняется без изменений.
- **`protection-execution`** — **изменяется дважды**: малое дополнение в Change 5 (guard), затем
  практически полная замена в Change 6.
- **`entry-cycle-recovery-resolution`** — **изменяется** Change 4 (атрибуционная логика), остальное
  (dual-query bounded retry, legacy pending_action guard, read-only гарантия) сохраняется.
- **`entry-package-execution`** — **дополняется** Change 1 (новые additive-поля/их заполнение), основной
  текст (order identity, create/cancel semantics, confirmation) не меняется.
- **`abi-position-management-api`, `abi-open-position-lookup-api`** — **только текстовые правки** prose
  (без изменения wire-схемы) в Changes 2, 3, 5, 6 — пояснить, что значения относятся к доле cycle, а не к
  физической позиции целиком; при необходимости — добавить новые коды ошибок (см. риск).
- **`exchange-instrument-identity`, `container-runtime`** — не затрагиваются.
- Отдельно, вне этой программы: **`abi-entry-package-exchange-canonical-confirmation-v1`** реализован,
  но не заархивирован в `openspec/changes/archive/` — рекомендуется провести housekeeping-архивацию
  до старта этой программы, чтобы baseline специй был чистым для дифов новых changes.

---

## 6. Риски и спорные архитектурные решения (закрыть до apply)

1. **Источник `owned_quantity`.** Должен браться из данных собственного ордера cycle (исполненное qty
   именно этого ордера), а не из агрегированной позиции. Нужно технически подтвердить, что Bybit
   `/v5/order/realtime`/`/v5/order/history` действительно отдают исполненное qty/среднюю цену с
   достаточной точностью (exact-decimal) на уровне ордера — рекомендуется короткий technical spike
   против Demo API перед написанием proposal Change 1.

2. **Политика допуска дрейфа.** `sum(owned_quantity активных same-side owners)` может разойтись с живым
   агрегированным размером позиции (округления qtyStep у разных входов, ручное вмешательство,
   частичные fills). Нужно явно решить: fail-closed при превышении допуска (соответствует общей
   философии кода "fail closed over guessing") против soft-warn-and-proceed. Рекомендация — fail closed,
   но требуется явное подтверждение архитектора/пользователя, т.к. это может блокировать легитимные
   операции при временной рассинхронизации.

3. **Таксономия ошибок.** Opposite-side rejection и protection-guard для shared scope можно отдавать как
   существующий `internal_error` (не меняя "закрытый словарь" ошибок) либо ввести точные новые коды
   (лучше для наблюдаемости/дебага, но формально это additive-изменение текста closed-vocabulary таблиц
   в `abi-position-management-api`/`abi-entry-package-api`). Нужно решение до Change 5.

4. **Технические детали conditional-ордеров Bybit V5** для Change 6 (triggerBy, типы Stop/TakeProfit,
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

7. **Совместимость protection в single-owner случае (Change 6).** Нужно решить: сохраняется ли
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

---

## 7. Финальный рекомендуемый порядок реализации и smoke-verification

0. **Housekeeping (вне программы):** заархивировать `abi-entry-package-exchange-canonical-confirmation-v1`
   в `openspec/changes/archive/`, чтобы baseline специй был чист.
1. **Закрыть риски §6** (источник owned_quantity, политика дрейфа, таксономия ошибок, conditional-order
   детали, single-owner fallback в protection) — до написания первого proposal.
2. **Change 1** → apply → регрессия всего существующего test suite (ожидается 0 поведенческих изменений)
   → smoke: restart процесса на существующих данных, подтвердить, что single-owner scopes резолвятся
   идентично.
3. **Change 2** → apply → синтетические multi-owner тесты + полная регрессия close → smoke: реальный
   close на Bybit Demo для обычного single-cycle сценария, побайтово то же поведение, что до change.
4. **Change 3** → apply → аналогично → smoke: `GET open-position` на реальной Demo-позиции, `avgPrice`/
   `size` совпадают с тем, что сегодня отдаёт Bybit, для single-owner случая.
5. **Change 4** → apply → smoke: убить/перезапустить процесс посреди активного trade cycle на Demo,
   подтвердить recovery-state не изменился относительно baseline.
6. **Change 5 (активация)** → apply → это шаг с наибольшим риском живого поведения → smoke на Bybit
   Demo: два same-side entry-package на одном symbol от разных trade cycles оба успешно создаются и
   сосуществуют; третья opposite-side попытка отклоняется; `PUT protection` на любом из двух active
   owners отклоняется новым guard-кодом; close одного cycle уменьшает физическую позицию строго на его
   долю, второй cycle остаётся нетронутым (позиция и его открытость).
7. **Change 6** → apply → smoke на Bybit Demo: у двух same-side cycles независимые stop/take
   conditional-ордера; close одного cycle отменяет именно его conditional-ордера, не трогая ордера
   второго; (если возможно на тестовых объёмах) фактическое срабатывание stop одного cycle не влияет на
   открытость/protection второго.

Каждый шаг — самостоятельно принимаемый OpenSpec change с собственным proposal/design/tasks, отдельным
review и отдельным apply — согласно ограничению не смешивать несколько архитектурных ответственностей
в одном change.
