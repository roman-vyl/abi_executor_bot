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

> **Ревизия v5 — окончательная close semantics для Change 2 (Change 1 уже implemented + archived, не
> затронут).** Двенадцать согласованных решений:
> (1) **Close становится fraction-based trade-cycle command.** Целевая архитектура — не "закрыть всю
> физическую Bybit-позицию", а "закрыть `exposure_fraction` виртуальной exposure ЭТОГО trade cycle".
> Canonical единица — `exposure_fraction`. Runtime выражает относительное намерение, ABI резолвит
> абсолютный exchange quantity.
> (2) **V1 поддерживает только `exposure_fraction = "1"`.** Это не временный костыль — fraction-based
> semantics целевая долгосрочная модель; `0.5`/`0.25`/... зарезервированы под будущую partial-close
> capability, но Change 2 её не реализует. Любое значение, отличное от canonical `"1"`, — fail closed.
> Change 2 не вводит mutable remaining-exposure lifecycle, resize protection-ордеров или partial
> terminal states.
> (3) **Runtime не знает absolute quantity** — граница из v4 (Change 1) остаётся в силе: Runtime не
> получает, не хранит и не отправляет обратно абсолютный BTC quantity cycle.
> (4) **Публичный close-контракт меняется.** `DELETE /v1/.../open-position` заменяется на
> `POST /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/close` с телом
> `{"exposure_fraction": "1"}`. Старый `DELETE` canonical alias не сохраняется без доказанной
> необходимости backward compatibility. `GET .../open-position` — read-only lookup — не меняется.
> (5) **Требуется скоординированное изменение Runtime.** Текущий Runtime domain command
> `ClosePositionCommand(strategy_instance_id, trade_cycle_id)` должен получить
> `exposure_fraction="1"`; ABI OpenSpec не должен молча владеть изменениями чужого репозитория —
> delivery оформляется как два согласованных OpenSpec changes (ABI-side и Runtime-side), точный
> Runtime change-id не фиксируется здесь.
> (6) **Fraction=1 максимально переиспользует текущий `CloseApplicationService`-pipeline** (resolve →
> verify ownership → neutralize entry order → confirm terminality → query position → market reduceOnly
> close → verify → verify no attributable remainder → `terminal_closed`) — меняется semantic subject
> ("100% этого cycle" вместо "вся физическая позиция"), не сам lifecycle.
> (7) **Single-owner path** (до Change 5 — вся production сегодня): requested cycle exposure ==
> physical position, поэтому нынешний путь (live aggregate `row.size` как quantity, physical zero
> после close) сохраняется максимально нетронутым.
> (8) **Multi-owner synthetic path**: Change 2 обязан уже корректно работать на synthetic multi-owner
> repository state (fixtures как в Change 1), хотя production-активация — только Change 5. Postcondition
> формулируется через **requested cycle exposure**, а не обязательно `physical position == 0` —
> physical zero это частный случай single-owner.
> (9) **Quantity resolution для собственного cycle**: если entry-ордер ещё live/`PartiallyFilled`, ABI
> сначала гарантирует, что он больше не может добавить exposure (существующий cancel + bounded
> terminality-confirmation паттерн), и только после этого `cumulative_filled_qty` (Change 1) становится
> authoritative final exposure. Отдельный mutable `remaining_quantity` для V1 full-close-only не
> вводится.
> (10) **Drift/reconciliation** остаётся high-level инвариантом ("значимое расхождение
> ABI-attributed vs. live aggregate → fail closed"), но конкретный tolerance-алгоритм (например,
> "ровно один `qtyStep`") — **рассматриваемый вариант**, не утверждённый implementation contract;
> доказывается в design Change 2 на основании реальной Bybit qtyStep/normalization semantics.
> (11) **Future partial-close seam**: `exposure_fraction = 0.5` в будущем будет означать "закрыть 50%
> текущей virtual exposure этого cycle" — но partial-close execution, mutable owned remainder,
> cycle-остаётся-active-после-partial, resize/cancel-recreate protection-ордеров, protection coverage
> fraction и partial-close reconciliation policy — всё вне scope Change 2. Change 2 проектирует
> контрактную ось, реализует только `"1"`.
> (12) **Protection relationship**: `exposure_fraction` — общая будущая семантика position-management
> intent; позже protection должна прийти к смыслу "protect `exposure_fraction = 1` этого cycle", а не
> "защитить всю физическую Bybit-позицию". Changes 6–8 не переписываются сейчас; protection HTTP
> contract этой ревизией не меняется.

> **Ревизия v6 — safety-коррекция multi-owner close confirmation (по итогам review первого
> OpenSpec-proposal для Change 2, до apply).** v5 п.10 ("drift/reconciliation vs. live aggregate")
> оказался небезопасной моделью, а не просто незафиксированным деталем: aggregate-delta
> (`aggregate_before − aggregate_after`) не может доказать, что именно **этот** close-запрос произвёл
> наблюдаемое изменение, если другой same-side cycle тоже может двигать тот же aggregate. Конкретный
> сценарий: ABI отправляет reduceOnly close cycle A, ордер исполняется, но ABI падает до durable
> `terminal_closed`; retry заново резолвит "исходные" 4 BTC cycle A из его entry-фактов (immutable) и
> отправляет **второй** reduceOnly-ордер, который физически может забрать exposure cycle B. Это прямое
> нарушение изоляции "close cycle A никогда не трогает cycle B".
> Корректная модель (детали — `design.md` corrected-change'а): close получает **собственную
> атрибутируемую identity** — тот же паттерн, что уже проверенно работает для entry-package
> create/cancel (`buildEntryPackageOrderLinkId` + durable write **до** exchange-вызова + resend только
> после чистого `not_found` на повторном запросе, см. `entryPackageApplicationService.ts`). Two flat
> additive-поля на `EntryPackageExecutionRecord` (`close_order_link_id`, `close_order_id`) — не generic
> ledger, не event sourcing. Единственное admissible доказательство "эта cycle's exposure закрыта" —
> **собственный close-ордер этого cycle**, подтверждённый по своей же identity; aggregate остаётся
> только для side/existence-санитарной проверки перед первой отправкой, никогда не участвует в success
> gate. v5 п.10's global drift-tolerance config полностью убран (не переименован) — сравнение, ради
> которого он существовал, само устранено редизайном. Single-owner path (production сегодня) этой
> коррекцией не затронут — он безопасен структурно иначе (aggregate==0 доказывает "мой close" именно
> потому, что владелец один), и остаётся byte-for-byte нетронутым. См. corrected Change 2 ниже.

> **Ревизия v7 — второй architecture-review проход по паттернам execution/reconciliation зрелых
> trading-систем (FIX, Bybit primitives, NautilusTrader, LEAN, Hummingbot — изучены только как проверка
> инвариантов, не скопированы).** 14 находок классифицированы (A/B/C/D); подробности и полная таблица —
> review report сессии, не воспроизводится здесь целиком. Итог: v6-модель (Change 2) подтверждена верной
> почти по всем пунктам — никакого aggregate-delta success proof, никакого scope-wide lock, exact-quantity
> (не `>=`) execution matching, только cumulative- (не per-fill-) based confirmation, никакого нового
> generic ledger/OMS. Найдено ровно **две** category-A коррекции (обе — в `design.md`/спеке Change 2, без
> расширения его scope): (1) исходный текст decision про dispatch/retry описывал только failure-path
> успешной отправки close-ордера, не explicit crash-window coverage — исправлено явным sequential
> ensure-dispatched-then-always-confirm flow и таблицей из пяти crash-windows (A–E); (2) свойство "durable
> unresolved close identity защищена от конфликтующей entry-package мутации" уже верно в существующем,
> неизменённом коде (`confirmEntryPackageCancelled`'s `hasFill`-check), но никогда не было
> зафиксировано как явный `close-execution` requirement и не тестировалось — теперь зафиксировано и
> покрыто тестом, без новой логики. Остальные находки — category B (уже верно, ничего не добавлено) или
> category C (future-only заметки, размещены здесь и в Changes 2/7/8/§6, не расширяют Change 2's
> implementation scope): fill-derived exposure equation (Change 2's "Future partial-close seam"), individual-
> execution dedup / multi-channel convergence (§6 риск 13), protection resize по exposure_fraction (Change
> 7), OCO-style sibling-leg neutralization (Change 8). Sequencing-вывод: Change 2 (corrected) уже полностью
> владеет close retry/restart recovery; Change 4 (recovery) менять не требуется — до Change 5 activation
> единственный exchange-write pipeline, способный затронуть shared-scope exposure, это close, и он уже
> безопасен на всех проверенных crash-windows.

> **Ревизия v8 — окончательная семантика Change 3 (`abi-pair-scoped-open-position-resolution-v1`),
> Change 2 уже applied/архивирован пользователем.** Применяет к open-position тот же
> attributable-evidence-vs-weak-aggregate-sanity паттерн, который Change 2 уже подтвердил для close.
> Три решения: (1) aggregate position остаётся weak sanity (`exists AND side compatible`) — никакого
> `size ≥ cumulative_filled_qty`-сравнения и quantity-drift tolerance, та же причина, что и в v6/v7 для
> close; (2) `first_fill_at_ms` формально определён как canonical entry strategy-bar identity (не raw
> timestamp), вычисляется один раз из первого attributable fill и сохраняется **durable** — это первое
> новое additive-поле на correlation-записи с момента Change 1 (имя — design-фаза Change 3, рабочий
> пример `entry_bar_open_time_ms`); wire-имя `first_fill_at_ms` не меняется. Открыт явный design-вопрос:
> предварительное code-исследование (см. Change 3 ниже) показало, что ABI сегодня **нигде** не хранит
> strategy timeframe/interval/grid — только одну временную метку `source_plan_bar_open_time_ms`
> (`src/domain/entryPackageApi.ts:3`), не длительность; design-фаза должна определить, знает ли ABI
> достаточно, или нужен минимальный immutable input, не изобретая Runtime/Engine API заранее; (3)
> `position_open` переопределён как fill-derived (`own cumulative fill > 0 AND not terminal_closed`),
> а не aggregate-existence-derived — верно и при живом `PartiallyFilled` entry-ордере. Wire-контракт
> `GET .../open-position` не меняется по форме. Change 3 proposal ещё не создан этой ревизией —
> только master-plan скорректирован.

> **Ревизия v9 — коррекция границы ответственности First Fill (по итогам review v8, до proposal Change
> 3).** v8's Decision 2 ошибочно назначила ABI ответственность за знание strategy timeframe/grid и за
> durable-хранение canonical entry-bar identity. Это неверно и отменяется: ABI не знает и не должна
> знать strategy timeframe/grid — этим уже владеет Runtime. Единственная ответственность ABI —
> execution-факт конкретного cycle: `first_fill_at_ms` — это trustworthy timestamp первого
> attributable fill **собственного** entry-ордера этого cycle, не более. ABI **не нормализует** этот
> timestamp к strategy bar. Runtime (уже владеющий strategy timeframe/grid) получает от ABI raw
> `first_fill_at_ms`, сам нормализует его к open time содержащей strategy bar и персистит это
> immutable canonical значение в уже существующем на стороне Runtime `FrozenExecutedReceipt`/frozen
> receipt lifecycle; Engine получает уже замороженную каноническую bar identity от Runtime, не от ABI.
> Поток: `Bybit execution → ABI raw attributable first_fill_at_ms → Runtime + timeframe → canonical
> entry bar open time → FrozenExecutedReceipt → Engine`. Из Change 3 **убрано**: требование к ABI знать
> timeframe/grid; любая candle-grid normalization логика внутри ABI; durable ABI-поле вида
> `entry_bar_open_time_ms`; claim "Change 3 добавляет одно новое additive durable поле"; тесты 3/4/5 из
> v8's required-tests (cross-bar/same-bar normalization, durability канонического bar-поля). Из Change 3
> **сохранено без изменений**: Decision 1 (aggregate — weak sanity только) и Decision 3
> (`position_open` — fill-derived per cycle, `PartiallyFilled` с fill > 0 → `position_open = true`,
> `average_entry_price` — из собственных cumulative execution facts, никогда aggregate `avgPrice`); в
> `GET .../open-position` по-прежнему не добавляется quantity-поле. Единственный остающийся открытый
> design-вопрос для будущего Change 3 OpenSpec: нужно ли ABI отдельно durable сохранять raw first-fill
> execution timestamp, или существующих Bybit/correlation primitives достаточно для его надёжного
> восстановления по требованию. Cross-repo следствие: нормализация + freeze на стороне Runtime —
> отдельная будущая Runtime-side работа наряду с другими Runtime-изменениями этой программы, не
> проектируется в этом master-plan.

> **Ревизия v10 — согласующий проход для Change 4 (`abi-entry-cycle-recovery-attribution-v1`), Change 3
> (`abi-pair-scoped-open-position-resolution-v1`) уже applied/архивирован.** Change 4 ниже (как и весь
> раздел Changes 4–6, см. примечание к v4/v5 выше) всё ещё был написан в терминах v3 — до появления
> durable `first_fill_at_ms` (v8/v9) и до фактической реализации Change 3. Эта ревизия приводит Change 4
> в соответствие с тем, что Change 3 реально поставил, и закрывает ранее открытый design-вопрос: может
> ли recovery переиспользовать Change 3's durable-capture механизм `first_fill_at_ms`, не нарушая
> "Recovery resolution never causes an exchange side effect" (entry-cycle-recovery-resolution spec,
> текущий последний Requirement)?
>
> **Ответ — да, переиспользует буквально, без второй реализации.** "No exchange side effect" в этом
> Requirement всегда означал только "не отправляет create/amend/cancel ордера на биржу" (сам текст
> Requirement это и говорит: "ABI SHALL NOT cancel, amend, or create any order"). Он не говорит и никогда
> не говорил про read-only GET-запросы или про собственную durable-запись ABI — recovery уже сегодня
> делает GET-запросы к ордеру и к позиции как часть своей обычной работы. Вызов Bybit
> `/v5/execution/list` (тот же `resolveFirstAttributableFillAtMs`, что Change 3 уже реализовал и
> экспортирует из `src/services/entryPackage/packageConfirmation.ts`) — тоже read-only GET, и
> последующая durable-запись `first_fill_at_ms` в собственный correlation-record ABI — тоже не exchange
> side effect. Никакого конфликта с этим Requirement нет; текст Requirement уточняется явной scenario,
> чтобы это больше не читалось как открытый вопрос.
>
> **Финальная семантика Change 4** (заменяет весь текст Change 4 ниже, включая "Что меняется"/
> "Обязательные тесты"/"Зависит от"):
> 1. **`average_entry_price` для `position_open`** сурсится из **уже полученного** ответа собственного
>    order-запроса cycle (`getOrderByLinkId`/`getOrderHistory`, `BybitOrderView.avgPrice` —
>    `src/services/entryPackage/orderQueryResponseDecoder.ts:3-11`) — recovery этот запрос и так делает
>    каждую попытку для классификации `OrderRecoverySignal`; значение сегодня просто отбрасывается после
>    классификации. Правка — donести `avgPrice` через `live_with_fill`/`terminal_with_fill` варианты
>    `OrderRecoverySignal` вместо отдельного запроса. Ни разу больше не сурсится из aggregate
>    `row.avgPrice`.
> 2. **`first_fill_at_ms` для `position_open`** переиспользует **тот же самый** durable-capture-once
>    механизм, что `OpenPositionResolutionService.resolveLiveQueryAdmissible` уже реализует
>    (`src/services/openPosition/openPositionResolutionService.ts:226-287`): если
>    `record.first_fill_at_ms` уже durable — переиспользуется без exchange-запроса; если ещё нет —
>    вызывается `resolveFirstAttributableFillAtMs` и результат durable сохраняется один раз, под тем же
>    per-pair `KeyedMutex` (та же shared instance, что уже передаётся в
>    `OpenPositionResolutionService`/`ProtectionApplicationService`/`CloseApplicationService` из
>    `src/app/server.ts`), чтобы не гоняться с конкурентным `GET .../open-position` за один и тот же
>    durable-write слот одной и той же пары. `EntryCycleRecoveryResolutionServiceDeps` получает новую
>    зависимость `mutex: KeyedMutex`. Капча выполняется **только** внутри уже существующего bounded-retry
>    цикла recovery, только когда own-order evidence уже положительно доказал fill — не спекулятивно.
> 3. **Aggregate position query остаётся ровно тем, чем он уже является сегодня для `entry_order_live`/
>    `terminal_without_fill`/`terminal_after_fill`** — dual-positive-confirmation правило для этих трёх
>    состояний **не меняется** (это НЕ было architecturally сломано shared scope: own order query уже и
>    так cycle-scoped через `orderLinkId`, единственная поломка была именно в extraction
>    `firstFillAtMs`/`averageEntryPrice` из aggregate row для `position_open`). Меняется только
>    **источник фактов** внутри уже resolved `position_open`, не сама dual-query решётка состояний.
>    Формулировка "aggregate — weak sanity" в п.1 выше относится конкретно к тому, что aggregate больше
>    никогда не является источником этих двух полей — не к отмене её роли в определении самого
>    recovery_state.
> 4. **Обязательные тесты (заменяют список в Change 4 ниже):**
>    - Регрессия существующего `entryCycleRecoveryResolutionService.test.ts` для всех состояний, кроме
>      значений полей `first_fill_at_ms`/`average_entry_price` внутри `position_open` (эти значения
>      теперь могут отличаться от прежних aggregate-based фикстур и должны быть обновлены на
>      own-order-based).
>    - `position_open` использует `avgPrice` из own-order response, никогда `row.avgPrice` — тест с
>      расходящимися own-order/aggregate avgPrice подтверждает, что в ответе именно own-order значение.
>    - `first_fill_at_ms` уже durable → переиспользуется без вызова `getExecutionList`.
>    - `first_fill_at_ms` не durable → recovery вызывает `resolveFirstAttributableFillAtMs`, сохраняет
>      результат durable, следующий `resolve()` (recovery или open-position) переиспользует то же
>      значение без повторного вызова.
>    - Capture fails (`no_executions_found`/`ambiguous`) → fail closed (`internal_error`), `position_open`
>      не резолвится с фиктивным/estimated значением.
>    - Конкурентный `GET .../recovery-state` и `GET .../open-position` на одну и ту же пару, оба
>      триггерящие капчу одновременно — сериализуются mutex, никогда не гонятся за одним durable-write
>      слотом, итоговое значение единственно и совпадает у обоих ответов.
>    - Multi-owner (синтетические фикстуры, как в Change 1/2/3): recovery для cycle B не путает fill
>      cycle A с собственным — если у B нет собственного fill-evidence, B резолвится в
>      `entry_order_live`/`terminal_without_fill`, а не ложно в `position_open`, даже когда aggregate
>      показывает открытую позицию (это позиция A).
>    - Legacy `pending_action` guard (spec, "A binding left mid-amend...") продолжает работать без
>      изменений.
>    - Новая явная scenario в spec, подтверждающая, что read-only `getExecutionList` GET-запрос и
>      локальная durable-запись `first_fill_at_ms` НЕ являются exchange side effect по смыслу
>      "Recovery resolution never causes an exchange side effect".
> 5. **Зависит от.** Change 1, и теперь явно и жёстко — **Change 3** (уже applied), поскольку Change 4
>    напрямую переиспользует его экспортированный `resolveFirstAttributableFillAtMs` и его durable
>    `first_fill_at_ms` контракт на correlation-записи, а не только "тот же принцип" вслед за ним.
>
> Everything else in Change 4's original text below (цель, HTTP-контракты не меняются, "Осознанно вне
> scope") остаётся верным и не переписывается заново.

> **Ревизия v11 — исправление ошибочной premise ревизии v10 (blocker, найден review до apply Change 4).**
> v10 выше содержит ошибочный вывод (пункт 3): "aggregate query остаётся ровно тем, чем он уже является
> сегодня для `entry_order_live`/`terminal_without_fill`/`terminal_after_fill` — dual-positive-confirmation
> правило... не меняется, это НЕ было architecturally сломано shared scope". **Это неверно и отменяется.**
> Прямая проверка кода (`entryCycleRecoveryResolutionService.ts:220-235`, `resolveRecoveryState`)
> показывает: `entry_order_live` требует `positionFlat` (aggregate обязан положительно вернуть
> `no_position`); `terminal_without_fill` требует того же. При shared same-side scope aggregate для scope
> с уже открытой позицией sibling-cycle **никогда** не вернёт `no_position`, пока эта sibling-позиция
> открыта — значит cycle B с собственным genuinely `live_unfilled` entry-ордером (fill=0) никогда не
> сможет резолвить `entry_order_live`, пока sibling A держит scope, хотя own evidence B однозначно это
> доказывает. Идентичная поломка — для `terminal_without_fill`. Это настоящий, ранее не обнаруженный
> пробел, а не переформулировка уже исправленного sourcing-бага `first_fill_at_ms`/`average_entry_price`.
>
> **Исправленная семантика Change 4** (заменяет п.3 v10 полностью; пп. 1-2 v10 остаются в силе без
> изменений — sourcing `average_entry_price`/`first_fill_at_ms` не меняется этой ревизией):
> 1. Каждое из четырёх recovery states резолвится **прежде всего** из own durable/order/execution evidence
>    конкретного cycle (собственный entry-ордер; и, когда он доказывает fill, собственный close-ордер).
>    Aggregate position query — **никогда** обязательный co-equal сигнал; только узкий, per-state sanity
>    check, который может лишь заблокировать resolution, которую own evidence иначе бы дало, но никогда не
>    может сфабриковать resolution, которую own evidence не поддерживает.
> 2. `entry_order_live`/`terminal_without_fill` резолвятся из own order signal одного; fail closed —
>    только если aggregate положительно подтверждает открытую позицию на **противоположной** стороне
>    (genuine invariant violation, не нормальное shared-scope условие). Sibling той же стороны, aggregate
>    без позиции, или неудавшийся/inconclusive aggregate query — все совместимы с resolution.
> 3. `position_open` vs `terminal_after_fill` (once own entry order доказал fill) резолвятся через
>    собственный close-order identity этого cycle (`close_order_link_id`, уже durable, Change 2), **не**
>    через aggregate: если close никогда не был durable attempted для этого cycle — `position_open` (own
>    evidence, aggregate sanity — только existence на matching стороне, как Decision 1 Change 3); если
>    close был durable attempted — запрашивается собственная судьба **этого** close-ордера через тот же
>    read-only order-classification primitive, что recovery уже использует для entry-ордера, второй раз, с
>    другой identity (переиспользование Change 2's `close_order_link_id`, никакой новой close-machinery):
>    close-ордер подтверждён filled → `terminal_after_fill`, **aggregate вообще не консультируется** для
>    этого determination — это прямое исправление сценария из п.8 review-запроса: sibling A's aggregate
>    presence никогда не может заставить B, чей own close уже confirмed, ошибочно вернуться в
>    `position_open`; close-ордер подтверждён terminal-с-нулевым-fill (rejected) → `position_open` (own
>    evidence, та же aggregate sanity, что в предыдущем случае); любой другой close-ордер signal (live/
>    not_found/inconclusive) → fail closed.
> 4. Legacy `pending_action` guard и durably-closed fast path (`process()`'s код выше dual-query секции) —
>    не затронуты этой ревизией, сохраняются буквально.
> 5. Никакой новой close-side machinery: переиспользуется существующий `classifyOrderForRecovery`
>    (identity-agnostic уже сегодня) второй раз, и существующее durable поле `close_order_link_id` (Change
>    2) — ни одного нового adapter primitive, decoder, cancel/retry/dispatch пути.
> 6. Production-поведение (single-owner, `close_order_link_id` всегда `null` для non-durably-closed записи
>    single-owner close-пути) — идентично сегодняшнему для всех четырёх states, кроме уже известного из v10
>    `first_fill_at_ms`/`average_entry_price` fix внутри `position_open`.
>
> Полная truth table, decision-дерево и обоснование (включая почему `terminal_after_fill` НИКОГДА не
> консультирует aggregate — design.md Decision 3c) — в design-фазе Change 4 (OpenSpec
> `abi-entry-cycle-recovery-attribution-v1`), не здесь; этот пункт master-plan фиксирует только исправление
> ошибочной premise и итоговую архитектуру, не полный design.

> **Ревизия v12 — второй blocker в п.3/п.5 ревизии v11 (найден review до apply Change 4), исправлен.** v11
> п.3 использовал для close-ордера тот же `classifyOrderForRecovery`, что и для entry-ордера — этот
> primitive доказывает только **non-zero fill**, не то, что close-ордер закрыл ровно ожидаемое qty.
> Change 2 (`CloseApplicationService.resolveCloseOrderOutcome`) уже имеет более строгую semantics:
> terminality + exact qty match (`confirmEntryPackage` + `decimalEquals`) против ожидаемого qty. Reuse
> только coarse-classifier позволил бы **partial** close-ордер fill ошибочно репортиться как чистый
> `terminal_after_fill`. Исправлено: п.3 v11 заменяется на: close-ордер classification переиспользует
> **ровно** Change 2's exact-qty-match strictness через новый **минимальный shared read-only primitive**
> (`classifyOwnCloseOrderOutcome`, извлечён из single-shot ядра `resolveCloseOrderOutcome` в
> `packageConfirmation.ts`), который вызывают **оба** — `CloseApplicationService` (thin wrapper вокруг
> его собственного bounded-retry, поведение байт-в-байт сохранено) и `EntryCycleRecoveryResolutionService`
> (один раз на свою уже существующую bounded-retry попытку). Итоговая taxonomy для close-attempted fill
> case: exact qty match → `terminal_after_fill` (aggregate не консультируется, как и раньше); terminal
> zero-fill (rejected) → `position_open` (та же aggregate sanity, что и no-close-attempted case); terminal
> **partial**-fill (qty mismatch) → **fail closed** (новое: ни `position_open`, ни `terminal_after_fill` —
> genuine unresolved partial close, ABI не гадает, какое из двух состояний ближе); live/not_found/
> inconclusive → fail closed, без изменений. П.5 v11 ("никакой новой close-side machinery... ни одного
> нового primitive") уточняется: ровно один новый **shared, read-only, single-shot** classification
> primitive — не duplicate Change 2's логики, не generic OMS, не новый adapter/decoder/cancel/dispatch
> путь. Остальные пункты v11 (1, 2, 4, 6) остаются в силе без изменений.

> **Ревизия v13 — согласующий проход для Change 5 (`abi-same-side-virtual-exposure-ownership-v1`) по
> итогам короткого architecture-review против фактически применённых Changes 1-4, до proposal Change 5.**
> Текст Change 5 ниже (строки, описывающие "Что меняется"/"Затрагиваемые слои") недооценивал реальный объём
> claim-стороны работы и не называл два конкретных найденных findings. Сам review — единственный
> authoritative источник коррекции; сам master-plan текст Change 5 не переписывается заново построчно
> здесь, только фиксируются найденные поправки, которые proposal Change 5 обязан отразить.
>
> 1. **`EntryPackageCorrelationRepository.findOwnerByScope()`/`byScope` — single-pointer, непригоден для
>    admission/ownership-решений после активации multi-owner.** `byScope.set(scope, record)` на каждый
>    non-durably-closed write означает, что этот индекс помнит только **последнего** писавшего в scope, не
>    множество активных владельцев. Change 2 (`closeApplicationService.ts:124-129`) уже обнаружил эту
>    проблему для close и уже переключился на `findActiveRecordsForScope()` — Change 5 обязан применить
>    ровно то же самое решение (не новое) к двум оставшимся продакшн call sites: claim-check в
>    `EntryPackageApplicationService.createOrder()` и ownership re-verification в
>    `ProtectionApplicationService` (`protectionApplicationService.ts:93-102`). После Change 5
>    `findOwnerByScope()`/`byScope` — legacy/convenience primitive (не удаляется, реализация не меняется),
>    но больше не валиден ни для одного ownership-решения.
> 2. **Найден конкретный self-conflict баг, а не гипотетический риск.** Если пара B присоединяется к scope
>    той же стороны после пары A (так что `byScope` теперь указывает на B, поскольку он всегда отражает
>    последнюю запись), последующий retry/new-generation `createOrder()` для самой пары A
>    (`repeatPutRevalidate` → `createOrder()` при `order_link_id === null`) прочитает `owner = B`,
>    `isOwnedBySamePair(B, A) === false` и ошибочно вернёт conflict для законного retry пары A, хотя A
>    остаётся активным владельцем scope. Это прямое следствие уже существующей семантики
>    `findOwnerByScope`, а не новая проблема multi-owner эпохи — proposal Change 5 обязан явно
>    exclude-self из "остальных активных записей" ПЕРЕД сравнением стороны (это же исправляет баг).
>
> **Итоговая семантика claim (заменяет содержательно, но не переписывает построчно, "Что меняется" Change
> 5 ниже):** внутри уже существующего `scopeMutex.withKeyLock(...)` — `findActiveRecordsForScope(category,
> symbol)`, отфильтровать записи запрашивающей пары; если остальных нет → claim; если у всех остальных та
> же `desired_entry.side` → join; если хотя бы у одной противоположная — conflict; активная запись с
> `desired_entry === null` среди остальных → fail closed как contradiction (тот же безопасный ответ, что
> conflict — новый public error code для этого случая не нужен, см. ниже). Mutex/store/index — без
> изменений, никакой новой инфраструктуры.
>
> **Replay:** `rebuildScopeIndexFromReplay()` — правило меняется с "любая вторая активная запись → fail" на
> "смешанная сторона среди активных записей одного scope → fail"; сравнение — через локальную,
> непер­систентную `Map<scope, side>` внутри одного прохода replay (не новый постоянный индекс). Активная
> запись без usable `desired_entry.side` — readiness fail closed, тот же принцип, что уже применяется к
> записи без usable exchange binding.
>
> **Release:** отдельной работы не требует — уже полностью работает через существующую фильтрацию
> `isDurablyClosedEntryPackageStatus` внутри `findActiveRecordsForScope` и уже shipped
> `finalizeMultiOwnerClose` (Change 2). Формулировка Change 5 ниже ("Release generalized... реализовано в
> Change 2/1") читается как todo этого change — это неточность: это уже готовый prerequisite, не работа
> Change 5.
>
> **Protection guard:** новый явный error code `shared_scope_protection_unsupported` (422,
> `abi-position-management-api`, protection-only) — решение по риску §6 п.3 принято: admission-конфликт
> (opposite-side claim) остаётся на существующем `internal_error` (переиспользует уже существующий,
> явно задокументированный в `position-scope-exclusivity` принцип "no new public error code для
> admission conflicts"), а protection shared-scope guard получает **новый** код, поскольку это
> действительно новый, caller-actionable outcome (та же логика, что уже оправдала `close_execution_incomplete`
> в Change 2) — не симметрия ради симметрии.
>
> **Судьба capability id.** Мастер-план ниже предлагает завести новую capability
> (`virtual-exposure-ownership`) и перевести `position-scope-exclusivity` в статус superseded. Proposal
> Change 5 сознательно этого не делает: capability id остаётся `position-scope-exclusivity`, меняются
> только requirement-тексты внутри неё (тот же паттерн, что Change 3 уже применил к
> `open-position-resolution`, полностью переписав её центральную семантику без переименования). Ренейминг
> capability — отдельное, не заблокированное этим change, документационное решение.
>
> Полная truth table, design decisions и обоснование — в design-фазе Change 5 (OpenSpec
> `abi-same-side-virtual-exposure-ownership-v1`), не здесь.

> **Ревизия v14 — новый safety blocker, найден до apply Change 5: Change 5 БОЛЬШЕ НЕ activation.**
> `PUT .../entry-package` уже сегодня прикрепляет **position-level** protection в момент создания
> entry-ордера: `mapEntryPackageToBybit()` (`bybitOrderMapper.ts:107-129`) отправляет `tpslMode: "Full"`,
> `stopLoss`, `takeProfit` прямо в `/v5/order/create`. Это физическая позиция целиком, не per-order
> протекция — `PUT .../protection`'s собственный guard (v10-v13, вся предыдущая коррекция Change 5) защищал
> только отдельный endpoint, но не сам entry-package create. Если бы Change 5 реально разрешил второму
> same-side owner присоединиться к scope, его же собственный entry-ордер молча перезаписал бы TP/SL
> первого owner в момент постановки на биржу — до Change 6-8, до `PUT .../protection` вообще. Guard
> одного endpoint не делает same-side sharing безопасным, пока сам entry-package create несёт Full
> position-level TP/SL.
>
> **Следствие: единственная безопасная activation point всей программы — Change 8**, после того как
> pair-owned protection (Changes 6-7) реально заменит position-level `tpslMode: "Full"` per-cycle
> reduce-only ордерами — и для `PUT .../protection`, и (неявно) для того, что раньше делало entry-package
> create. Change 5 **не пытается** решить это через `tpslMode: "Partial"` или любой другой early fix —
> у программы уже есть полный, отдельно спроектированный ответ (Changes 6-8), решать это раньше значит
> дублировать работу и вносить небезопасный промежуточный шаг.
>
> **Роль Change 5 понижена до foundation/preparation**, тот же паттерн, что уже применён к Change 1 и
> Change 6: построить и полностью протестировать на synthetic multi-owner fixtures — `findActiveRecordsForScope`
> вместо `findOwnerByScope` (исправляет self-conflict баг заодно, независимо от того, activated ли
> same-side), side-aware replay reconstruction, `shared_scope_protection_unsupported` guard в protection —
> но **не разрешать реальное появление второго active owner в production**, даже same-side. Механизм:
> внутри admission-классификации (`findActiveRecordsForScope` + exclude-self + side-compare, уже полностью
> корректной и готовой) добавлен один явный, точечно закомментированный temporary guard — "любой другой
> active record (any side) → conflict", удаляемый только в Change 8. Replay's side-aware relaxation и
> protection's shared-scope guard остаются в коде уже сейчас (полностью протестированы на synthetic
> fixtures), но структурно недостижимы через реальные production write paths, пока guard в admission стоит
> — им не нужен собственный override, их недостижимость — следствие admission's guard, не отдельная логика.
>
> **Изменения в тексте программы** (прямые правки, не только эта ревизия): таблица §2 (строки Change 5/8),
> dependency graph §4, "Финальный рекомендуемый порядок" §7 (шаги 6 и 9) — везде убран "Activation #1" у
> Change 5, "Activation #2" у Change 8 переименован в единственную "Activation" программы; заголовок секции
> Change 5 (`### Change 5 — ...`) и Change 8 (`### Change 8 — ...`) обновлены точечно (только заголовок,
> тело Change 6/7/8 не переписывается). Demo smoke-тест шага 6 (Change 5) больше не проверяет same-side
> coexistence — эта проверка перенесена в шаг 9 (Change 8), где она впервые становится реально достижимой.
>
> Полная truth table, design decisions (включая точный код temporary guard'а) и обоснование — в
> design-фазе Change 5 (OpenSpec `abi-same-side-virtual-exposure-ownership-v1`), не здесь.

> **Ревизия v15 — Changes 6–8 переосмыслены вокруг нативной Bybit attached `tpslMode: "Partial"`
> модели вместо ABI-generated conditional-ордеров (найдено design-check'ом до proposal Change 6, до
> applied Change 5 не затрагивает).**
>
> **Что изменилось.** Весь предыдущий текст Changes 6–8 (v1–v14 этого документа) предполагал, что ABI
> сама создаёт, подписывает и управляет собственными reduceOnly conditional stop/take-ордерами: своя
> identity-схема (`stop`/`take` orderLinkId-роли), свой `protection_generation`, свой create-order
> payload, своя recovery-логика, своя OCO-семантика между двумя ногами. Это был архитектурно корректный
> и полностью проработанный вариант (отдельный design-check подтвердил: shared `protection_generation`
> на весь tuple достаточен, минимальный durable state — 7 additive-полей, deriving previous-generation
> identity через `generation − 1` безопасно, crash-windows все закрыты) — но он избыточен. Bybit уже
> сегодня предоставляет собственный нативный механизм: entry create уже прикрепляет position-level
> protection через `tpslMode: "Full"` (`mapEntryPackageToBybit()`, `bybitOrderMapper.ts:107-131`) —
> переключение этого же mapping в `tpslMode: "Partial"` заставляет Bybit materializes собственные child
> TP/SL-ордера **per parent order**, каждый несущий `parentOrderLinkId`, равный own entry orderLinkId
> родителя. ABI не обязана изобретать свой protection-lifecycle — она обязана научиться **достоверно
> обнаруживать и атрибутировать** то, что биржа уже создаёт сама.
>
> **Что удалено из объёма Changes 6–8 этой ревизией** (как преждевременная архитектура, не как
> опровергнутая): ABI-generated identity-роли `stop`/`take`; собственные `stop_order_link_id`/
> `take_order_link_id`/`stop_order_id`/`take_order_id`; `protection_generation`-счётчик; generic
> conditional reduce-only create-order payload под protection; recovery для ордеров, которые сама ABI
> никогда не создавала; любая ABI-side OCO-реализация. Ничего из этого не было ни предложено, ни
> применено как OpenSpec — переписывается только этот планирующий документ.
>
> **Что добавлено.** Change 6 — read/decode/classification foundation: главный новый primitive —
> query-driven атрибуция вида `own entry orderLinkId → Bybit order query → children WHERE
> parentOrderLinkId == own entry orderLinkId → классификация (STOP | TAKE | неопознанный)`, с fail-closed
> на любую неоднозначность (0 children при уже доказанном fill+Partial; больше двух подходящих; два
> одной роли — всё ambiguous, никогда не угадывается). Точные поля Bybit response (какое поле — родитель,
> какое отличает STOP от TAKE, гарантирует ли биржа атомарную OCO-нейтрализацию sibling-ноги) — предмет
> обязательного technical spike перед proposal Change 6, не предположение этого документа (см.
> переформулированный риск §6 п.4).
>
> **Новое sequencing (та же foundation → lifecycle → activation дисциплина, что уже применена ownership-
> цепочке Changes 1→5):**
> - **Change 6** (`abi-native-partial-protection-attribution-v1`) — read/attribution foundation;
>   entry-mapping остаётся `tpslMode: "Full"`; никаких новых durable-полей.
> - **Change 7** (`abi-native-partial-protection-lifecycle-v1`) — lifecycle замены native Partial
>   protection при изменении желаемого stop/take (решает "как заменить qty=4 на qty=7 без double/zero-
>   coverage окна"); production-инертен, guard из Change 5 не снимается, mapping остаётся Full.
> - **Change 8** (`abi-native-partial-protection-cutover-v1`) — единственный coordinated cutover:
>   entry-mapping `Full → Partial`, включение lifecycle из Change 7, снятие Change 5's temporary
>   admission guard и `shared_scope_protection_unsupported`, close-интеграция (own attributable Partial
>   children нейтрализуются при close). Единственная Activation программы — не меняется относительно
>   ревизии v14, меняется только то, из чего состоит cutover.
>
> **Что не меняется этой ревизией.** Changes 1–5 (applied/archived или, для Change 5, уже
> implemented+archived как foundation) не затрагиваются и не переоткрываются — Change 5's temporary
> guard остаётся ровно тем, что уже реализовано, его снятие остаётся работой Change 8. "Архитектурное
> решение: protection" ниже переписано (вариант B помечен отклонённым/superseded вариантом C, не
> удалён из истории). Change 6/7/8's собственные тела ниже переписаны полностью, а не точечно, тем же
> способом, каким ревизия v5 переписала Change 2 целиком.
>
> Полная truth table, точная Bybit response shape и design decisions — design-фаза Change 6 (после
> technical spike), не здесь.

> **Ревизия v16 — Change 7 переписан вокруг подтверждённого direct-amend поведения Bybit (Change 6
> applied и archived, найдено Demo spike'ом до proposal Change 7).**
>
> **Что подтвердил spike.** Native `tpslMode: "Partial"` protection children можно менять **in place**
> через `POST /v5/order/amend` по exact child `orderId` (Change 6's уже реализованная атрибуция даёт
> этот `orderId`) — не только читать. Подтверждено против реального Bybit Demo: `orderId`,
> `parentOrderLinkId`, `stopOrderType`, `createType`, `tpslMode: "Partial"` все сохраняются через amend;
> `triggerPrice` меняется независимо на каждой ноге; `qty` можно resize и вниз, и вверх, одним amend
> вместе с `triggerPrice`; изменение `qty` одной ноги **автоматически синхронизирует** `qty` sibling-ноги
> (доказанный факт, не предположение); новых children не создаётся, дубликатов роли не возникает; Change
> 6's classifier после amend по-прежнему возвращает `attributed`; наблюдаемого окна без активного SL не
> было. **OCO-семантика после amend остаётся `NOT PROVEN`** — не проверялась и не может считаться
> доказанной этим спайком.
>
> **Что это отменяет.** Весь объём Change 7 из ревизии v15 ("Что меняется": `cancel old legs → confirm
> neutralized → создать новую native Partial пару под текущим qty`, "центральный нерешённый вопрос" про
> qty=4→qty=7 через cancel/recreate, double-coverage/zero-coverage окна как риск именно cancel/recreate
> подхода) — **superseded**, не расширен: реальное поведение Bybit устраняет саму cancel/recreate
> проблему, которую v15 пыталась решить. Это тот же класс коррекции, что ревизия v14 уже применила к
> Change 5 (найденный до apply факт меняет саму механику, не только детали) — тело Change 7 переписано
> полностью, а не точечно, тем же способом, каким v15 переписало Changes 6-8 и v5 переписало Change 2.
>
> **Новая цель Change 7.** Production-инертный **reconciliation lifecycle**: `desired protection state`
> (`stop_price`/`take_price | null` из `PUT .../protection`, `qty = current authoritative own
> cumulative_filled_qty`, Change 1) против `actual attributable native Partial children` (Change 6's
> `resolveOwnAttachedProtection()`) — если совпадает, no-op; если нет, **amend** существующих children по
> exact `orderId`, затем fresh bounded read-back, success только если attribution/triggers/qty всё ещё
> соответствуют desired на всех ногах. Полная sequence, design decisions и test-требования — в
> Change 7's собственном теле ниже, переписанном этой ревизией.
>
> **Что явно НЕ вводится этой ревизией** (переносится как обязательные design/spike-вопросы Change 7,
> не решается здесь): (1) как получить `STOP active + TAKE absent` — spike cleanup показал, что cancel
> одной ноги может задеактивировать sibling тоже, поэтому "просто cancel take-ногу" не доказанно
> безопасно; (2) fresh-evidence дисциплина против triggered/filled/deactivated-race между read и amend —
> без слепого replacement; (3) multi-fill representability — Change 7 не должен предполагать auto-resize,
> additional pairs или single-pair-per-parent, а обязан reconcile против того, что Change 6's classifier
> реально способен представить, расширяя classifier только по доказанному evidence, никогда заранее;
> (4) OCO-after-amend остаётся `NOT PROVEN` — отдельный evidence-item, нужный до Change 8/cutover, если
> Change 8's close/activation semantics будут на него полагаться; сам ABI не проектирует OCO-engine.
>
> **Что не меняется этой ревизией.** Changes 1-6 не переоткрываются (Change 6 уже applied и archived).
> Change 7 остаётся полностью production-инертен: `mapEntryPackageToBybit()` остаётся `Full`, Change 5's
> admission guard остаётся, `shared_scope_protection_unsupported` остаётся,
> `ProtectionApplicationService.process()`'s production-decision path остаётся на `setTradingStop`/
> `tpslMode: "Full"` — новый reconciler тестируется исключительно напрямую, не через production path.
> Change 8 остаётся единственной Activation программы; Change 8's тело правится этой ревизией только
> точечно (формулировка, ссылавшаяся на несуществующие теперь "Change 7's cancel-примитивы"), не
> redesign.
>
> Полная truth table аменда, точный write-plan (одна amend-транзакция на ногу vs. на пару) и design
> decisions по всем четырём вопросам выше — design-фаза Change 7, не здесь.

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
   `src/exchange/bybitAdapter.ts:278-292`). У этого API физически нет способа независимо обслуживать
   несколько trade cycles одного symbol — значит текущий protection-execution обязан быть либо
   переосмыслен, либо временно заблокирован для shared-scope, пока не переосмыслен. **[Ревизия v15]**
   Тот же `tpslMode`-параметр, который сегодня отправляет `"Full"`, поддерживает нативный `"Partial"`
   режим — Bybit сам materializes per-parent-order protection children вместо position-level protection;
   переосмысление — атрибуция нативных children, не изобретение ABI-собственных conditional-ордеров.

5. **Concurrency сегодня уже дружелюбна к multi-owner**: mutex-гранулярность — `(strategy_instance_id,
   trade_cycle_id)` пара (`src/concurrency/keyedMutex.ts`, используется одним и тем же instance во всех
   трёх application services — `src/app/server.ts:47,69,80`), а не per-scope. Scope-level mutex
   (`scopeMutex`) используется только транзиently, только в момент claim, никогда не держится через
   Bybit-вызов. Значит per-pair сериализация НЕ требует изменений — меняется только семантика самого
   scope-claim.

6. **Order identity уже cycle-scoped**: `orderLinkId = abi-ep-{sha256(strategyInstanceId, tradeCycleId,
   role, generation)}` (`src/domain/entryPackageOrderIdentity.ts:8-20`). **[Ревизия v15]** После пивота к
   native Partial attribution это не паттерн для новых ABI-generated protection-ролей — это сам якорь
   атрибуции: собственный entry `order_link_id` этого cycle — единственное значение, по которому
   нативные Bybit Partial TP/SL children должны совпасть через `parentOrderLinkId`, чтобы быть законно
   приписаны этому cycle. Никакой новой identity-схемы Change 6 не вводит — она читает то, что Bybit уже
   связывает с уже существующим entry-identity.

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

Сравнены три варианта:

- **A. Position-level protection с виртуальной координацией** (агрегированный/усреднённый stop-take на
  всю физическую позицию). Отклонён: физически невозможно честно обслужить два разных желаемых
  stop/take одновременно через один `/v5/position/trading-stop`; закрытие одного cycle требует
  пересчитывать/переотправлять общий stop для оставшихся; нарушает уже существующий инвариант
  "exact numeric match to accepted values" per pair (protection-execution spec L75-119).
- **B. ABI-generated pair-owned reduce-only conditional exit orders** (собственный stop-order и
  take-order на cycle, свои orderLinkId-роли `stop`/`take`, свой `protection_generation`, свой
  create/cancel/confirm lifecycle, своя OCO-логика между двумя ногами). Изначально выбран (эта секция и
  Changes 6–8 в ревизиях v1–v14 этого документа) как архитектурно корректный — единственный вариант с
  честной per-cycle изоляцией, переиспользующий уже отработанные паттерны (order identity, bounded
  confirmation, reduceOnly semantics close-execution). **Отклонён ревизией v15** — не как некорректный
  (отдельный design-check перед proposal Change 6 подтвердил: shared `protection_generation` на весь
  tuple достаточен, минимальный durable state — 7 additive-полей, все crash-windows закрыты), а как
  избыточный: он заставил бы ABI спроектировать и доказать безопасной собственную OCO-семантику, которую
  Bybit уже реализует атомарно на своей стороне для варианта C.
- **C. Native Bybit attached `tpslMode: "Partial"` protection, атрибутированная через `parentOrderLinkId`**
  (выбран ревизией v15). Тот же механизм, который ABI уже использует сегодня для `tpslMode: "Full"` на
  entry create (`mapEntryPackageToBybit()`, `bybitOrderMapper.ts:107-131`), но переключённый в
  `"Partial"` режим: Bybit materializes собственные child TP/SL-ордера **per parent order**, а не per
  physical position, каждый несущий `parentOrderLinkId`, равный own entry orderLinkId этого cycle. ABI
  не создаёт, не подписывает и не отменяет собственные conditional-ордера — она **читает и атрибутирует**
  то, что Bybit уже создал сам, тем же query-driven способом, каким `packageConfirmation.ts` уже читает
  собственный entry-ордер по его identity. Устраняет необходимость в: собственной identity-схеме под
  protection, собственном generation-счётчике, собственном create-order payload, собственной
  recovery-логике для никогда-не-ABI-созданных ордеров и — главное — собственной OCO-реализации, если
  Bybit сам гарантирует атомарную нейтрализацию sibling-ноги (предстоит технически подтвердить в
  Change 6, не предполагать заранее). Долгосрочно protection тоже придёт к семантике `exposure_fraction`
  (см. ревизию v5, Change 2): "protect `exposure_fraction = 1` этого cycle" — protection HTTP contract
  не меняется ни вариантом B, ни вариантом C.

Вариант C реализуется, как и отклонённый вариант B, **тремя** отдельными changes (6, 7, 8 — см. ниже), но
с другим распределением работы: Change 6 — read/decode/classification foundation (никакого изменения
production-поведения, включая entry-mapping — остаётся `tpslMode: "Full"`); Change 7 — lifecycle замены/
обновления native Partial legs при изменении желаемого stop/take (production-инертен, guard не
снимается); Change 8 — единственный coordinated cutover: mapping `Full → Partial`, включение lifecycle,
снятие Change 5's temporary admission guard и `shared_scope_protection_unsupported`, close-интеграция —
всё одним контролируемым шагом. Та же гарантия, что уже применена к базовой ownership-цепочке (Changes
1 → 5): ни один applied change не оставляет систему в небезопасном промежуточном состоянии.

### Нужен ли отдельный "foundation" change до изменения execution semantics?

**Да, дважды** — не только для базовой ownership-цепочки (Change 1), но и для protection (Change 6).
Оба раза принцип один: сначала эволюция read/attribution-примитивов поверх уже существующей identity
(без изменения наблюдаемого поведения, тестируется независимо на synthetic/фикстурных данных), потом
изменение бизнес-политики/execution поверх уже стабильного фундамента. **[Ревизия v15]** Для Change 6 это
больше не "эволюция данных/идентичности" в смысле новых durable-полей — это эволюция способности
достоверно читать и классифицировать то, что Bybit уже создаёт сам; сам принцип "foundation до policy"
не меняется.

### Ключевой сиквенс-инсайт (важно для порядка ниже)

Нельзя просто "разрешить второму cycle присоединиться к scope" (activation) раньше, чем close/open-position/
recovery станут owner-aware — иначе в первый же момент реального multi-owner состояния close снесёт
**всю** физическую позицию (включая долю соседнего cycle), а protection одного cycle начнёт незаметно
управлять экспозицией другого. Поэтому план **готовит** consumers (close, open-position, recovery) к
multi-owner заранее — их новая ветка логики тестируется на **синтетически подготовленных** multi-owner
фикстурах (репозиторий это позволяет без изменения claim-политики), пока производственная claim-политика
всё ещё эксклюзивна. Реальная активация (разрешение второго owner) становится последним, самым маленьким
и самым безопасным шагом среди "базовых" changes. Тот же принцип (после ревизии v3, объём переосмыслен
ревизией v15, механика переосмыслена ревизией v16) применён и к protection: native Partial reconciliation
lifecycle строится и тестируется в Change 7 production-инертно (entry-mapping остаётся Full), активация —
включая mapping cutover — только в Change 8.

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
- `close` становится **fraction-based trade-cycle command**: Runtime выражает относительное намерение
  `exposure_fraction` для конкретного `(strategy_instance_id, trade_cycle_id)`, ABI резолвит абсолютный
  Bybit-quantity из собственного per-cycle state (`cumulative_filled_qty`, формализованного Change 1,
  один раз `isFillFactFinal`) и материализует reduceOnly close. V1 принимает только canonical
  `exposure_fraction = "1"` (100% этого cycle) — любое иное значение fail closed; это не временный
  костыль, а целевая долгосрочная модель, под которую зарезервированы будущие `0.5`/`0.25` (партиал
  close вне scope Change 2). При единственном owner (сегодняшнее production-состояние) поведение и
  результат идентичны сегодняшним (`row.size` живой агрегированной позиции, physical zero после close);
  при synthetic multi-owner (до Change 5) closes только запрошенный cycle, физическая позиция может
  остаться ненулевой — постусловие формулируется через exposure запрошенного cycle, а не через
  `physical position == 0`.
- `protection` до Change 8 явно блокируется (fail closed) для scope с >1 активным owner; сам redesign
  (в три этапа — foundation/execution-lifecycle/close-cleanup+активация) переводит protection на
  pair-owned reduceOnly conditional stop/take-ордера с собственными orderLinkId на cycle. Guard снимается
  только в Change 8, не раньше. Долгосрочно protection тоже придёт к семантике `exposure_fraction`
  ("protect `exposure_fraction = 1` этого cycle"), но это не входит в scope Change 2.
- Recovery перестаёт полагаться на side-match агрегированной позиции как на доказательство "моя
  позиция" — авторитетным становится статус **собственного** ордера cycle.
- Публичные HTTP-контракты `PUT entry-package`, `GET open-position`, `PUT protection` **не меняются по
  форме** во всей программе. Единственное исключение — **close**: `DELETE .../open-position`
  заменяется в Change 2 на `POST .../close` с телом `{"exposure_fraction": "1"}`, без сохранения
  старого `DELETE` как alias без доказанной необходимости. `GET .../open-position` (read-only lookup)
  не затрагивается этим решением. Это требует скоординированного изменения Runtime
  (`ClosePositionCommand` получает `exposure_fraction`) — см. Change 2 и §6 рисков. Текстовые правки
  prose (без изменения wire-схемы) остаются нужны для `abi-open-position-lookup-api` и для протокольно
  неизменных частей `abi-position-management-api` (protection).
- Каждый applied change в программе (1–8) оставляет систему в безопасном, полностью определённом
  production-состоянии — активационных моментов ровно два: Change 5 (базовое ownership) и Change 8
  (protection).

---

## 2. Упорядоченная последовательность changes

| № | change-id | Capability(ies) | Тип |
|---|---|---|---|
| 1 | `abi-virtual-exposure-state-foundation-v1` | новая: virtual-exposure-state (+ additive к entry-package-execution) | Data model, без изменения поведения |
| 2 | `abi-pair-scoped-close-execution-v1` | `close-execution` + `abi-position-management-api` (contract change) | **Public contract change** (`DELETE .../open-position` → `POST .../close`, `exposure_fraction`) + consumer prep (owner-aware); требует скоординированного Runtime change |
| 3 | `abi-pair-scoped-open-position-resolution-v1` | `open-position-resolution` | Consumer prep (owner-aware, wire-контракт без изменений; durable-поле — открытый design-вопрос, см. Change 3) |
| 4 | `abi-entry-cycle-recovery-attribution-v1` | `entry-cycle-recovery-resolution` | Consumer prep (owner-aware) |
| 5 | `abi-same-side-virtual-exposure-ownership-v1` | `position-scope-exclusivity` (internal mechanism only); guard в `protection-execution` | **Foundation, не activation** (ревизия v14) — admission-механика и side-aware replay готовятся и тестируются на synthetic fixtures; production exclusivity (максимум один active owner на scope, любой стороны) сохраняется temporary guard'ом до Change 8 |
| 6 | `abi-native-partial-protection-attribution-v1` | read/attribution primitives поверх уже существующей `entry-package-execution` order identity (+ additive к `protection-execution`, без новых durable-полей) | Read/decode/classification foundation, без изменения поведения — mapping остаётся `tpslMode: "Full"` (переосмыслен ревизией v15) |
| 7 | `abi-native-partial-protection-lifecycle-v1` | `protection-execution` | Native Partial reconciliation lifecycle via direct amend, **production-инертно** (guard из Change 5 не снимается, mapping остаётся Full; переосмыслен ревизией v15, механика переосмыслена ревизией v16) |
| 8 | `abi-native-partial-protection-cutover-v1` | `entry-package-execution` (mapping switch Full→Partial), `protection-execution`, `close-execution` (расширение) | Coordinated cutover + **единственная Activation программы** (ревизии v14/v15) — снимает Change 5's admission guard, тем самым реально включает same-side multi-owner в production |

Changes 2, 3, 4 формально зависят только от Change 1 и **не зависят друг от друга** — их можно вести
параллельно/в любом порядке. Change 8 можно слить с Change 7 только если объединённый change по-прежнему
не активирует guard-снятие до того, как cleanup-логика полностью реализована и протестирована — то есть
слияние меняет группировку работы, но не меняет правило "guard снимается последним". Ниже дан
рекомендованный линейный порядок для одной команды.

**Change 2 — единственный change во всей программе с внешней (cross-repo) зависимостью**: его
production-развёртывание требует скоординированного изменения Runtime (`ClosePositionCommand` должен
научиться отправлять `exposure_fraction`). Это не ABI-внутренняя зависимость и не должно решаться
внутри ABI OpenSpec — delivery оформляется как два согласованных change в двух репозиториях (ABI-side
и Runtime-side), с явной cross-repo atomic-rollout зависимостью между ними (см. Change 2 и §6).

---

## 3. Детали по каждому change

### Change 1 — `abi-virtual-exposure-state-foundation-v1`

> Статус: **применено и заархивировано**. Реализация — `isFillFactFinal` (`packageConfirmation.ts`),
> monotonicity-валидация в `save()`/`replay()` и `findActiveRecordsForScope`
> (`entryPackageCorrelationRepository.ts`) — landed, все задачи `tasks.md` отмечены `[x]`, полный
> тестовый набор (531/531) и `typecheck`/`build` зелёные. Канонический спек синхронизирован в
> `openspec/specs/virtual-exposure-state/spec.md`; change перемещён в
> `openspec/changes/archive/2026-08-17-abi-virtual-exposure-state-foundation-v1/`.

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

**Цель.** Заменить close с "закрыть всю физическую Bybit-позицию" на **fraction-based trade-cycle
command**: "закрыть `exposure_fraction` виртуальной exposure ЭТОГО `(strategy_instance_id,
trade_cycle_id)`", материализуемую ABI из собственного per-cycle state (quantity ownership boundary,
Change 1). V1 реализует единственное canonical значение `exposure_fraction = "1"`. Это меняет
**публичный HTTP-контракт**, не только внутреннюю реализацию close — см. ревизию v5. **Ревизия v6**
скорректировала безопасность multi-owner confirmation — см. ниже и ревизию v6 выше. **Ревизия v7**
уточнила dispatch/confirm control flow и explicit crash-window coverage по итогам второго
architecture-review — см. ревизию v7 выше; сам HTTP-контракт и multi-owner identity model этой
ревизией не меняются.

**High-level flow:**

```
Runtime:
  POST close, exposure_fraction = "1"
ABI:
  1. resolve requested cycle, reconfirm active membership on its scope
  2. neutralize/finalize its own live entry order
  3. resolve authoritative cycle exposure (own entry order's fill facts)
  4. [multi-owner only] dispatch/resolve own close order under an attributable identity
  5. execute reduceOnly close (single-owner: unconditionally; multi-owner: only if no prior
     attempt is already dispatched, or a fresh one is genuinely never-created)
  6. verify requested cycle exposure is fully closed — single-owner: aggregate == 0; multi-owner:
     the cycle's OWN close order's own confirmed execution, never an aggregate-delta inference
  7. verify own attributable active orders are neutralized
  8. terminalize only requested cycle
```

**Single owner** (сегодняшнее production-состояние, до Change 5): requested cycle exposure ==
aggregate position → сегодняшний algorithm сохраняется максимально нетронутым, **byte-for-byte, без
единого нового поля или Bybit-вызова** → physical zero ожидается после close.

**Multi-owner synthetic** (fixtures как в Change 1, production — только после Change 5): requested
cycle exposure < aggregate position → close закрывает только собственный qty, под собственной
атрибутируемой identity; aggregate может остаться ненулевым; sibling cycle остаётся live. Пример:

```
cycle A = 4 BTC, cycle B = 6 BTC, Bybit aggregate = 10 BTC
Runtime: close A, exposure_fraction=1
ABI: neutralize/finalize entry order A → resolve authoritative exposure A = 4 →
     durably write close_order_link_id(A) BEFORE dispatch → reduceOnly qty=4 под этой identity →
     confirm THIS order's own executed qty == 4 → terminal_closed(A)
Ожидаемо: aggregate → 6; A → terminal_closed; B остаётся active
```

Главный postcondition формулируется через **exposure запрошенного cycle, атрибутируемо доказанную
собственным close-ордером этого cycle**, а не обязательно через `physical position == 0` (single-owner
частный случай) и **никогда** через `aggregate_before − aggregate_after` (см. v6 — это доказанно
небезопасно при >1 owner, т.к. сосед тоже может двигать aggregate).

**Safety blocker и его коррекция (v6).** Исходный draft резолвил multi-owner qty из entry-фактов cycle
и доказывал успех сравнением aggregate до/после. Ревью нашло эксплуатируемую дыру: после
crash/timeout между "close-ордер исполнился" и "durable `terminal_closed`" retry заново резолвит те же
исходные 4 BTC (immutable entry-факты не меняются) и отправляет **второй** reduceOnly-ордер — который
может забрать exposure соседнего cycle B, поскольку aggregate delta не различает "мой close" от "чужая
конкурентная активность". Корректная модель — **атрибутируемая close-order identity**, тот же паттерн,
что уже проверенно работает для entry-package create/cancel (`buildEntryPackageOrderLinkId` + durable
write **до** exchange-вызова + resend только после чистого `not_found` при повторном запросе). Полная
retry/restart state machine (never-dispatched / dispatched-but-lost-response-actually-filled /
dispatched-still-live-or-ambiguous / dispatched-zero-execution / dispatched-partial-execution) —
`design.md` соответствующего OpenSpec change; здесь фиксируется только архитектурный вывод:
**ABI никогда не отправляет второй close-ордер для того же full-close intent, пока судьба ранее
отправленного не подтверждена по его собственной identity.**

**Публичный HTTP-контракт (меняется).** Долгосрочная canonical форма:

```
DELETE /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/open-position
```

заменяется на command-style endpoint:

```
POST /v1/strategy-instances/{strategy_instance_id}/trade-cycles/{trade_cycle_id}/close
Body: { "exposure_fraction": "1" }
```

Значение, отличное от canonical `"1"` (`"0.5"`, `"0"`, отрицательное, malformed, отсутствующее) — fail
closed до любого exchange-вызова и до любой durable-записи. Старый `DELETE` **не сохраняется** как
alias без доказанной необходимости backward compatibility — decommission, а не deprecation-период.
`GET .../open-position` — read-only lookup — этим решением **не затрагивается**, остаётся прежним.

**Скоординированное изменение Runtime (внешняя зависимость).** Текущий Runtime domain command
`ClosePositionCommand(strategy_instance_id, trade_cycle_id)` и его HTTP-адаптер (пустой `DELETE`)
должны стать `ClosePositionCommand(strategy_instance_id, trade_cycle_id, exposure_fraction="1")`.
Точный Python/type representation — решение будущего Runtime OpenSpec, не этого документа. ABI OpenSpec
**не должен молча владеть** изменениями в другом репозитории — delivery оформляется как **два
согласованных OpenSpec changes**: (1) ABI close-contract/execution change (этот, Change 2 программы);
(2) Runtime ABI-client/domain-command change (отдельный репозиторий, change-id пока не фиксируется).
Cross-repo atomic-rollout зависимость между ними должна быть явной на этапе планирования rollout —
конкретный механизм (одновременный deploy, временное окно совместимости, feature-flag на стороне
Runtime) не решается в этом master-plan, это отдельный operational вопрос design/rollout-фазы.

**Что меняется.** `CloseApplicationService` (`src/services/close/closeApplicationService.ts:153-179`)
переиспользуется максимально для single-owner (byte-for-byte, см. выше); multi-owner получает новую
ветку:
- Валидация `exposure_fraction`: только canonical `"1"` принимается для V1; любое иное значение — fail
  closed без exchange-вызова, без durable-записи.
- Single-owner (ровно один активный owner scope) — **не меняется вообще**: ни одного нового поля, ни
  одного нового Bybit-вызова.
- Multi-owner (owners > 1): сначала гарантируется терминальность **собственного** entry-ордера closing
  cycle (как и раньше); `cumulative_filled_qty` этой записи (once `isFillFactFinal`) резолвится
  transient, in-memory (никогда не пишется в `early_execution_observation` — close остаётся вне
  observation-writing points `virtual-exposure-state`). Close-ордер отправляется под **детерминированной
  own identity** (`buildEntryPackageOrderLinkId(sid, tcid, "close", generation)` — расширение уже
  существующей entry-package identity-схемы новой ролью, не новая схема), **durably записанной до**
  exchange-вызова. Retry/restart сначала резолвит судьбу уже записанной identity (через
  `confirmEntryPackage`/`classifyEntryOrderTerminality` — уже существующие generic-примитивы, не новые)
  и только при чистом `not_found` безопасно повторяет отправку под той же identity — новую identity
  (generation bump) V1 не вводит; экзекуция с нулевым/частичным исполнением фейлится закрыто
  (`close_execution_incomplete`), без auto-retry под новой identity.
- Success gate — **исключительно собственный close-ордер cycle**, подтверждённый по своей identity;
  aggregate используется только один раз до отправки (side + existence-санити), никогда не как proof
  after-the-fact. Никакого global drift-tolerance config — сравнение, которое он бы толерировал,
  устранено самим редизайном (обе стороны сравнения происходят из одного и того же запроса).
- Release-семантика: при durable close этого cycle запись убирается из `owners`-множества scope
  (структура `byScope`, если Change 5 к этому моменту её уже ввела — Change 1/2 сознательно не трогают
  `byScope`); сторона (`side`) scope очищается лишь когда множество owners становится пустым.

**Какие инварианты отменяются/заменяются.**
- close-execution spec L110-124 ("close size сурсится исключительно из live aggregate query, никогда
  из ABI-recorded/calculated quantity") — заменяется на "при единственном owner — как раньше; при
  множественном — обязательно из собственного close-ордера cycle, подтверждённого по своей own
  identity". Единственный настоящий разворот философии в этой программе; квалифицируется отдельно как
  риск (см. §6).
- Публичный контракт `DELETE .../open-position` (close-семантика в `abi-position-management-api`) —
  заменяется на `POST .../close` с `exposure_fraction`. Это wire-level breaking change, не только
  prose-уточнение.

**Новые инварианты.** "Close закрывает ровно `exposure_fraction` виртуальной exposure запрошенного
cycle, оставляя чужие доли нетронутыми"; "Runtime никогда не передаёт и не получает абсолютное exchange
quantity — только `exposure_fraction`"; "V1 принимает только `exposure_fraction = "1"`, любое иное
значение fail closed до любого side-эффекта"; "**ABI никогда не отправляет второй close-ордер для того
же full-close intent, пока судьба ранее отправленного не подтверждена**"; "успех доказывается
исключительно собственным close-ордером cycle, никогда aggregate-delta"; "release из owner-множества не
подразумевает release всего scope, пока есть другие активные owners".

**Затрагиваемые слои.** `src/services/close/closeApplicationService.ts` (multi-owner-ветка с
attributable close-identity), `src/domain/entryPackageOrderIdentity.ts` (`EntryPackageOrderRole` →
добавляется `"close"`), `src/correlation/entryPackageExecutionRecord.ts` (два новых additive-поля,
`close_order_link_id`/`close_order_id`, только на этой записи — не на `virtual-exposure-state`'s
observation), `src/exchange/bybitOrderMapper.ts` (`orderLinkId?` на close-payload), HTTP-слой: новый
`POST .../close` route/handler в `src/routes/positionManagementRoutes.ts`; `abi-position-management-api`
OpenAPI-спека. `EntryPackageCorrelationRepository`'s indexing/replay/`byScope` **не затрагиваются** —
минимум durable state оказался двумя плоскими полями на уже существующей записи, не новым store/index.

**HTTP-контракты.** **Меняются.** `DELETE /v1/.../open-position` retired, заменяется на
`POST /v1/.../close` с `{"exposure_fraction": "1"}`. `GET /v1/.../open-position` не затрагивается.
`PUT .../entry-package`, `PUT .../protection` не затрагиваются этим change. `abi-position-management-api`
spec для close переписывается по существу (метод, путь, request body, error-vocabulary — новый код
`close_execution_incomplete` вместо ранее черновой `position_exposure_drift`).

**Future partial-close seam (не реализуется здесь).** `exposure_fraction = 0.5` в будущем означает
"закрыть 50% текущей virtual exposure этого cycle" — Change 2 закладывает контрактную ось под это
значение, но не реализует его. Вне scope: partial close execution; mutable owned remainder; cycle
остаётся active после частичного закрытия; resize/cancel-recreate protection-ордеров; protection
coverage fraction; partial-close reconciliation policy; generation-scoped close-identity bump для
auto-retry после нулевого/частичного исполнения (fail closed в V1 — намеренно). **Будущий инвариант
(зафиксирован ревью по итогам изучения FIX/NautilusTrader/LEAN/Hummingbot-style execution-архитектур,
не проектируется здесь):** долгосрочная virtual exposure cycle — это `attributable entry fills −
attributable close fills`, а не отдельное mutable поле; V1's full-close-only модель (`final entry fill
qty → full close attributable execution той же qty → terminal_closed`) уже является частным случаем
этого уравнения при `close fills == entry fills`, и уже полностью реализована corrected Change 2 без
отдельного ledger. Partial-close stage должен применить то же уравнение с `close fills < entry fills`,
не изобретать новую модель.

**Обязательные тесты.**
- `exposure_fraction = "1"` принимается; `"0.5"`, `"0"`, `"2"`, malformed, отсутствующее значение — fail
  closed до любого exchange-вызова, без durable-записи.
- Single-owner: полная регрессия исполнения — идентична сегодняшней, даже при изменённой транспортной
  обёртке (новый HTTP endpoint); diff доказуемо не редактирует существующий код, только добавляет ветку.
- Multi-owner (синтетические фикстуры, как в Change 1) — retry/restart state machine покрыта явно:
  (A) close ни разу не отправлялся → отправляется один раз под детерминированной identity;
  (B) отправлялся, ответ потерян, ордер реально исполнился → retry не шлёт второй ордер, завершает
  terminal-write из восстановленных данных;
  (C) отправлялся, судьба ещё live/ambiguous → retry не шлёт замену, fail closed;
  (D) отправлялся, судьба — нулевое исполнение → `close_execution_incomplete`, без auto-retry под
  новой identity;
  (E) отправлялся, судьба — частичное исполнение → `close_execution_incomplete`, partial fill не
  засчитывается как success;
  (not-found resend) отправлялся, но биржа не имеет записи вообще → безопасный resend под той же
  identity.
- Sibling cycle B (status, close-identity, fill facts, active-membership) не меняется при close cycle A.
- `avg_execution_price`/`early_execution_observation` этого cycle и соседних не изменяются в результате
  close (close остаётся вне observation-writing points).
- Replay backward-compat: durable-запись без `close_order_link_id`/`close_order_id` вообще (pre-change
  данные) реплеится успешно.
- Новые route/DTO-тесты для `POST .../close`; `GET .../open-position` — полная регрессия, не затронут.

**Зависит от.** Change 1. Плюс внешняя (cross-repo) зависимость: скоординированный Runtime change —
ABI Change 2 не может быть безопасно выкачен в production без него (см. §6 рисков).

**Состояние после.** Close — fraction-based command с новым публичным HTTP-контрактом и retry/restart-
safe multi-owner confirmation через атрибутируемую own-order identity. Для single-owner (сегодняшнее
production-состояние) поведение и результат идентичны сегодняшним, byte-for-byte; для synthetic
multi-owner (до Change 5) корректно и безопасно закрывает только запрошенный cycle, даже при
crash/retry. Production rollout требует скоординированного Runtime-изменения.

**Осознанно вне scope.** `exposure_fraction < 1` (partial close execution); mutable durable owned
remainder; resize/cancel-recreate protection-ордеров; protection coverage fraction; partial-close
reconciliation policy; generation-scoped close-identity bump для auto-retry после нулевого/частичного
исполнения; global drift-tolerance config (убран полностью — сравнение, которое он бы толерировал,
устранено редизайном); cross-owner aggregate reconciliation как отдельная observability-проверка;
same-side production activation (Change 5); opposite-side coexistence; native Partial protection
attribution/lifecycle/cutover (Changes 6–8, переосмыслено ревизией v15); `first_fill`/entry-bar
resolution (Change 3); recovery redesign (Change 4); Runtime,
хранящий/пересылающий абсолютный quantity; ABI → Runtime push; portfolio/netting engine; точный Runtime
change-id и его wire-представление (будущий Runtime OpenSpec).

---

### Change 3 — `abi-pair-scoped-open-position-resolution-v1`

**Цель.** Архитектурная идея №2 — open-position pair-scoped на основе virtual exposure конкретного
trade cycle, а не агрегированной физической позиции, с учётом того, что собственный entry-ордер cycle
может ещё не быть терминальным (partial fill, живой). **Wire-контракт не меняется**: ответ
`GET .../open-position` по-прежнему содержит только `position_open`/`first_fill_at_ms`/
`average_entry_price` (`src/domain/openPositionApi.ts:4-14`) — никакой quantity/size-поле не
добавляется.

**Ревизия v8 — окончательная семантика Change 3** (по итогам review, применяющего к open-position тот
же architectural pattern, что Change 2 уже применил и подтвердил для close: собственная
attributable order/execution evidence — источник истины; агрегированная Bybit-позиция — только
weak sanity/reconciliation evidence, никогда gate). Ниже — три согласованных решения.

**Decision 1 — aggregate position остаётся слабым sanity-слоем, без quantity-сравнения.** Change 2
уже показал (ревизия v6/v7), что сравнение `aggregate vs. ABI-resolved quantity` небезопасно как
proof — aggregate физической позиции shared и асинхронно меняется при multi-owner scope, а local
per-pair mutex не делает aggregate delta attributable. Та же логика применяется здесь: Change 3
**не вводит** сравнение вида `aggregate size ≥ cumulative_filled_qty этого cycle, в пределах
допуска`, и никакого quantity-drift tolerance под это сравнение. Формулировки из более ранних ревизий
этого документа про такое сравнение — устарели и заменяются этой ревизией (см. §9 "Consistency
check" ниже). Если существующей семантике (side-match) вообще нужен sanity-check против aggregate,
он должен быть **не строже**, чем:

```
aggregate physical position exists
AND
physical side is compatible with this cycle's own side
```

— то есть ровно то, что `open-position-resolution` уже делает сегодня как "plausibility check, не
proof of attribution" (spec L166-177), не более. Aggregate НЕ является и не становится источником
`position_open`, `average_entry_price`, `first_fill_at_ms` или per-cycle quantity. Если own-cycle
execution evidence и aggregate sanity противоречат друг другу (например: собственный ордер cycle
показывает fill, но aggregate физической позиции вообще не существует) — ABI fail closed, согласно
уже принятой во всей программе error-философии; конкретный error-код (переиспользовать
`internal_error` или ввести точный новый) — решение design-фазы Change 3, не master-plan.

**Decision 2 (пересмотрена ревизией v9) — `first_fill_at_ms` — это ABI's own raw attributable
first-fill timestamp, не canonical entry strategy-bar identity.** v8 ошибочно назначила ABI
ответственность знать strategy timeframe/grid и вычислять/хранить canonical entry-bar identity. Это
отменяется. Согласованная граница ответственности:

```
Bybit execution
→ ABI: raw attributable first_fill_at_ms (собственный entry-ордер этого cycle)
→ Runtime (владеет strategy timeframe/grid): нормализация к open time содержащей strategy bar
→ FrozenExecutedReceipt (Runtime-side frozen receipt lifecycle): immutable canonical значение
→ Engine: получает уже замороженную каноническую bar identity от Runtime
```

- **ABI не знает и не должна знать** strategy timeframe/interval/grid ни сейчас, ни после Change 3.
  Единственная ответственность ABI — execution-факт конкретного cycle: `first_fill_at_ms` — это
  trustworthy timestamp первого attributable fill **собственного** entry-ордера этого cycle
  (переиспользует уже существующие own-order confirmation-примитивы, `packageConfirmation.ts`'s
  `confirmEntryPackage`/`classifyEntryOrderTerminality` — не новый query-механизм).
- **ABI не нормализует** этот timestamp к strategy bar. Никакой candle-grid normalization логики
  внутри ABI не вводится — ни в этом change, ни позже в рамках этой программы.
- **Никакого нового ABI-durable canonical-bar поля.** v8's claim "Change 3 добавляет ровно одно новое
  additive durable поле (canonical entry-bar open time)" — retracted. Нормализацию и durable freeze
  выполняет Runtime через уже существующий на его стороне `FrozenExecutedReceipt`/frozen receipt
  lifecycle — концепция, которой в `abi_executor_bot` нет и не будет.
- **Wire-naming не меняется.** `first_fill_at_ms` в публичном ответе ABI остаётся собственным raw
  attributable first-fill timestamp этого cycle — trustworthy, own-order-sourced, не canonical
  strategy-bar open time (это описание теперь относится к производному значению Runtime, не к
  значению, которое отдаёт ABI).

**Единственный остающийся открытый design-вопрос для будущего Change 3 OpenSpec (не решается здесь).**
Нужно ли ABI отдельно durable сохранять raw first-fill execution timestamp этого cycle, или
существующих Bybit/correlation primitives достаточно, чтобы надёжно восстановить/reconstruct его по
требованию при каждом `GET .../open-position`. Design-фаза Change 3 решает это по факту исследования
существующих own-order query-примитивов, не master-plan.

**Cross-repo следствие.** Нормализация `raw first-fill timestamp → strategy bar open time` и её freeze
в `FrozenExecutedReceipt` — отдельная будущая работа на стороне Runtime, ведётся вместе с другими
Runtime-изменениями этой программы (например, Change 2's coordinated `exposure_fraction`-companion),
не проектируется и не оформляется как ABI OpenSpec change в этом документе.

**Decision 3 — `position_open` — fill-derived per cycle, а не aggregate-existence-derived.** Для
конкретного cycle `position_open` больше не определяется фактом существования aggregate Bybit
позиции (сегодняшнее поведение: `OpenPositionResolutionService.determine()`,
`src/services/openPosition/openPositionResolutionService.ts:101-140`, читает `firstFillAtMs`/
`averageEntryPrice` напрямую из `queryResult.row` — агрегированной live-позиции). В текущей
full-close-only архитектуре (`exposure_fraction` только `"1"`, partial close — future work, здесь не
проектируется) логическая семантика:

```
own attributable cumulative entry fill > 0
AND
cycle is not terminal_closed
→ position_open = true
```

Entry-ордер **не обязан** быть terminal. Пример: `calculated_quantity = 10`, `cumExecQty = 3`,
`order_status = PartiallyFilled` → `position_open = true` для этого cycle. Если durable
`early_execution_observation` может быть stale (живой/partial ордер), `OpenPositionResolutionService`
обязан выполнить **целевой refresh** собственного entry-ордера через уже существующие
confirmation/query примитивы (`packageConfirmation.ts`), а не полагаться на aggregate position для
attribution. `average_entry_price` сохраняет уже принятое направление: это собственная cumulative
average execution price cycle (из `early_execution_observation`/refresh), никогда aggregate Bybit
`avgPrice`. При live partial fill целевой refresh должен возвращать актуальный cumulative average
execution price. Ни один новый execution ledger не вводится, если существующих cumulative order
facts (`cumulative_filled_qty`/`avg_execution_price`) для этого достаточно — design-фаза Change 3
обязана это подтвердить, не предполагать.

**Industry-pattern rationale (кратко, не обзор продуктов).** FIX/OMS-архитектуры отделяют order/
execution identity от aggregate position state; NautilusTrader — logical position/exposure
fill-derived, не aggregate-derived; LEAN/Hummingbot трактуют `PartiallyFilled` как нормальное live
order state, не как "нет открытой exposure"; собственные Bybit order/execution/history primitives
(уже используемые ABI в `packageConfirmation.ts`) дают достаточную attributable per-cycle evidence
без обращения к aggregate. Change 3 применяет тот же паттерн, что и Change 2, к чтению вместо записи.

**Что меняется.** `OpenPositionResolutionService.determine()`
(`src/services/openPosition/openPositionResolutionService.ts:101-140`):
- `position_open` резолвится из own attributable cumulative fill (> 0) и статуса `terminal_closed`,
  не из факта существования aggregate live-позиции (Decision 3).
- `average_entry_price` сурсится из `cumulative_filled_qty`/`avg_execution_price`
  (`early_execution_observation`, формализованного Change 1); если entry-ордер cycle ещё не
  `isFillFactFinal` (живой/partial), сервис выполняет целевой refresh (переиспользуя существующий
  query/decode из `packageConfirmation.ts`, без нового механизма) и отвечает актуальным cumulative
  avgPrice.
- `first_fill_at_ms` отдаёт собственный raw attributable timestamp первого fill entry-ордера этого
  cycle (Decision 2, пересмотрена v9) — trustworthy own-order-sourced значение, без какой-либо
  candle-grid нормализации внутри ABI; нормализацию к strategy bar выполняет Runtime отдельно.
- Live-запрос агрегированной позиции (`queryPositionForInstrument`) сохраняется только как weak
  existence/side sanity-check (Decision 1) — никогда как источник quantity/цены/времени и никогда с
  quantity-сравнением/tolerance.

**Какие инварианты отменяются/заменяются.**
- open-position-resolution spec L166-177 (side-match — "plausibility check, не proof of attribution")
  — сохраняется как sanity-слой в том же слабом виде, не усиливается до quantity-проверки.
- L193-199 ("avgPrice/first_fill sourced напрямую из live row, never estimated") — заменяется:
  при единственном owner источник фактически тот же (совпадает), при множественном — обязателен
  собственный источник per-cycle, т.к. агрегированная Bybit-позиция физически не может отдать
  раздельные avgPrice/first-fill на владельца. `position_open`'s текущее определение через факт
  существования aggregate-позиции — заменяется на fill-derived определение (Decision 3).

**Новые инварианты.** "Ответ open-position для cycle отражает `position_open`/`average_entry_price`/
`first_fill_at_ms` именно этого cycle, независимо от того, сколько ещё активных cycles делят тот же
physical scope, и независимо от того, терминализирован ли уже собственный entry-ордер cycle."
"`position_open = true` возможен при живом `PartiallyFilled` entry-ордере, если cumulative fill > 0."
"Canonical entry-bar identity вычисляется один раз и durable — повторные запросы не пересчитывают её
заново." "Ответ никогда не содержит и не подразумевает per-cycle quantity — это исключительно
внутреннее понятие." "Aggregate position никогда не является gate/proof — только weak sanity evidence
(Decision 1)."

**Затрагиваемые слои.** `src/services/openPosition/openPositionResolutionService.ts` (новая
зависимость на query/decode-примитивы из `packageConfirmation.ts` для refresh-пути; новая логика
position_open/own-attributable first-fill sourcing). `src/correlation/entryPackageExecutionRecord.ts`
— затронут ли этот файл вообще, и если да, то каким конкретно additive-полем (durable raw first-fill
timestamp), решает **design-фаза Change 3** по итогам единственного открытого design-вопроса
(Decision 2 выше) — master-plan не фиксирует это заранее. Routes/DTO слой
(`src/routes/openPositionRoutes.ts`, `src/domain/openPositionApi.ts`) не меняется по форме — поле
quantity туда не добавляется, `first_fill_at_ms`/`average_entry_price`/`position_open` остаются теми
же именами и типами.

**HTTP-контракты.** `GET .../open-position` — схема ответа (имена, типы, nullability полей) не
меняется. Семантика двух полей уточняется в prose `abi-open-position-lookup-api`: `first_fill_at_ms` —
собственный raw attributable first-fill timestamp этого cycle (own-order-sourced, не производится
никакой candle-grid нормализацией внутри ABI — эта нормализация происходит на стороне Runtime);
`average_entry_price` — собственная cumulative average execution price этого cycle, не aggregate
Bybit avgPrice. `position_open` — явно документируется как fill-derived, включая live partial-fill
случай.

**Обязательные тесты.** Минимум:
1. Single-owner регрессия (значения идентичны сегодняшним, поведение observably не меняется).
2. Два same-side synthetic owners с разным собственным `average_entry_price`.
3. Живой `PartiallyFilled` собственный entry-ордер с ненулевым cumulative fill → `position_open = true`.
4. Целевой refresh обновляет актуальный собственный cumulative avgPrice.
5. Aggregate-позиция, принадлежащая только sibling cycle, НЕ делает запрошенный cycle
   `position_open = true`.
6. Расхождение aggregate existence/side sanity с own-cycle evidence — fail closed, если такой
   sanity-check остаётся в реализации.
7. Сериализованный ответ по-прежнему не содержит quantity-поля.
8. `first_fill_at_ms` в ответе — собственный raw attributable first-fill timestamp этого cycle, не
   подвергается никакой candle-grid/bar-normalization логике внутри ABI (регрессионный тест против
   случайного повторного введения bar-normalization).

**Зависит от.** Change 1.

**Состояние после.** Open-position готов к multi-owner и к живому partial-fill; `position_open`
корректен для partial-fill cycle; canonical entry-bar identity durable и стабилен через restart; в
проде поведение идентично сегодняшнему до Change 5.

**Осознанно вне scope.** Любое расширение wire-контракта `GET .../open-position` (quantity-поле туда
не добавляется ни в этом change, ни позже в рамках этой программы); user-facing partial close
(`exposure_fraction < 1`); protection redesign; close-order identity/retry-семантика (уже реализовано
Change 2); generic execution ledger; fill-level dedup subsystem; WebSocket execution ingestion; global
reconciliation mode; cross-cycle scope mutex; implementation Changes 4–8; Runtime companion
close-contract change (Change 2's забота); **знание strategy timeframe/grid внутри ABI и любая
candle-grid normalization логика внутри ABI (v9 — явно и окончательно отменено, не входит в scope ни
этого, ни будущих ABI changes)**; нормализация `first_fill_at_ms → canonical entry bar open time` и её
freeze в `FrozenExecutedReceipt` — это отдельная будущая Runtime-side работа, не ABI OpenSpec. Изменение
error-таксономии `abi-open-position-lookup-api` сверх уже существующей (кроме, возможно, нового кода на
явное aggregate/own-evidence противоречие — решение design-фазы).

---

> **Примечание к ревизиям v4/v5.** Правки v4 применены к Change 1–3, правки v5 — к Change 2 (публичный
> close-контракт, `exposure_fraction`, coordinated Runtime change) плюс точечные уточнения в top-level
> секциях и в Changes 7–8 (см. правки ниже). Changes 4–6 ниже всё ещё частично написаны в терминах v3
> (`VirtualExposure`-тип, ранняя эволюция `byScope` внутри Change 1) и требуют отдельного согласующего
> прохода, прежде чем на них можно опираться буквально. Архитектурные решения v4/v5 (quantity ownership
> boundary, `exposure_fraction`-based V1 full-close-only, отсутствие `first_fill_at_ms`/mutable
> remainder в Change 1/2, новый close HTTP-контракт) остаются в силе для всей программы — реализация
> Changes 4–8 не должна опираться на поля/контракты, которые Change 1/2 больше не вводят.

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

### Change 5 — `abi-same-side-virtual-exposure-ownership-v1` (Foundation — production exclusivity сохраняется; см. ревизию v14)

**Цель.** Архитектурная идея №1 — заменить physical-scope exclusivity на virtual same-side exposure
ownership. **Уточнено ревизией v14: Change 5 — foundation-only, не production activation.** Механика
(full-set lookup, exclude-self, side-aware classification/replay preparation, protection guard) строится
и полностью тестируется на synthetic fixtures здесь, но temporary admission guard сохраняет сегодняшнюю
exclusivity (максимум один active owner на scope, любой стороны) в production. Единственный change,
реально включающий multi-owner в production — Change 8, снятием этого guard.

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

**Осознанно вне scope.** Сам protection redesign (native Partial attribution/lifecycle/cutover — Changes
6–8, переосмыслено ревизией v15); поддержка opposite-side (намеренно остаётся запрещённой согласно
требованию пользователя); любой netting/portfolio-движок.

---

### Change 6 — `abi-native-partial-protection-attribution-v1` (переименован и переосмыслен ревизией v15; старый id `abi-pair-owned-protection-state-foundation-v1` не был предложен как OpenSpec и не используется)

**Цель.** Научить ABI **достоверно обнаруживать и атрибутировать** собственные protection-ноги
(stop/take) конкретного cycle, materialized Bybit'ом нативно через `tpslMode: "Partial"` на entry-ордере
— не создавать, не подписывать и не управлять собственными conditional-ордерами. Это read/decode/
classification foundation, полностью production-инертный: entry create остаётся на `tpslMode: "Full"`,
`PUT .../protection` продолжает работать через `/v5/position/trading-stop` в точности как сегодня.

**Модель.** `EntryPackageExecutionRecord` уже знает own entry orderLinkId этого cycle
(`order_link_id`, `entryPackageExecutionRecord.ts:88`). При `tpslMode: "Partial"` Bybit после fill
materializes собственные child TP/SL-ордера, каждый несущий `parentOrderLinkId`, равный own entry
orderLinkId родителя. Атрибуция сводится к:

```
EntryPackageExecutionRecord.order_link_id (own entry)
        ↓
Bybit order query (realtime + history, те же примитивы, что packageConfirmation.ts уже использует)
        ↓
children WHERE parentOrderLinkId == own entry orderLinkId
        ↓
классификация каждого найденного child: STOP-нога | TAKE-нога | неопознанный
```

**Что меняется.**
- Новый read-only primitive (рабочее название `resolveOwnAttachedProtection(entryOrderLinkId)` →
  `{ stop: AttachedProtectionLeg | null; take: AttachedProtectionLeg | null }` либо явный ambiguous/
  contradiction-исход) в `packageConfirmation.ts` или соседнем модуле — по аналогии с уже существующими
  `classifyEntryOrderTerminality`/`classifyOwnCloseOrderOutcome`: то же query-driven, ничего не хранящее
  устройство, никакого нового durable state под это НЕ заводится в Change 6.
- Технический spike и decode-слой над реальной Bybit response shape (переформулированный риск §6 п.4):
  какие поля реально нужны для однозначной атрибуции и классификации — `parentOrderLinkId` (атрибуция,
  требует подтверждения против реального Bybit V5 response, не документации на веру), `orderId` (audit),
  поле, надёжно отличающее Stop-Loss child от Take-Profit child (точное имя подтверждается спайком),
  `triggerPrice`, и какие именно из `qty`/`cumExecQty`/`leavesQty` нужны уже классификации (существование/
  тип), а какие только будущему Change 7 (sizing/coverage) — решается в design-фазе, не здесь.
- Строгая классификация обнаруженного набора children для одного own entry orderLinkId:
  - **0 children** — допустимо, если fill ещё не произошёл (entry live/unfilled) или mapping для этого
    entry ещё не Partial (сегодняшнее — единственное — production-состояние); но **contradiction**, если
    own fill facts (`early_execution_observation`, Change 1) уже доказывают finality И mapping для этого
    entry был Partial — недостижимо в production Change 6 (mapping остаётся Full), проверяется только на
    synthetic fixtures.
  - **ровно один STOP + один TAKE** — attributable protection pair, единственный "здоровый" исход после
    fill под будущим Partial mapping.
  - **что угодно ещё** (0 при уже доказанном fill+Partial; больше двух подходящих; два одной роли; child
    без опознаваемой роли) — **ambiguous → fail closed**, никогда не угадывается и не выбирается
    "наиболее подходящий" кандидат.
- `EntryPackageCorrelationRepository`/`EntryPackageExecutionRecord` — **никаких новых durable полей** в
  этом change (в отличие от объёма ревизий v1-v14 этой секции): никаких `stop_order_link_id`/
  `take_order_link_id`, никакого `protection_generation`. Атрибуция полностью query-driven от уже
  существующего `order_link_id`, тем же принципом, что уже применён к finding #6 выше и к Change 1's
  "не заводить новых полей там, где существующие уже корректны".
- Mapper/DTO-подготовка для `tpslMode: "Partial"` (`bybitOrderMapper.ts`) — **пишется и тестируется**
  (payload-shape тесты против фикстур), но **не подключается** к production `mapEntryPackageToBybit()`,
  которая остаётся на `"Full"` до Change 8 — тот же паттерн temporary-guard/production-инертности, что
  уже применён к Change 5's admission guard.

**Какие инварианты отменяются.** Ни один — entry create и `PUT .../protection` производственно
неотличимы от состояния до этого change.

**Новые инварианты.** "Own attached protection children этого cycle однозначно атрибутируются через
`parentOrderLinkId == own entry orderLinkId`, никогда через side-match или другую эвристику." "Любое
состояние набора children, не являющееся ровно {0 при отсутствии fill/Partial} или {STOP+TAKE}, fail
closed как ambiguous — никогда не разрешается эвристикой 'бери первый подходящий'."

**Затрагиваемые слои.** Новый read-only primitive (`packageConfirmation.ts` или соседний модуль),
decode-слой для order-query responses (расширение `orderQueryResponseDecoder.ts` полями
`parentOrderLinkId` и тем, что понадобится для роль-классификации), `bybitOrderMapper.ts` (новый,
неподключённый Partial-payload). Не трогает `EntryPackageExecutionRecord`,
`EntryPackageCorrelationRepository`, `ProtectionApplicationService`, `CloseApplicationService`.

**HTTP-контракты.** Не меняются.

**Обязательные тесты.**
- Классификация: 0 children (fill отсутствует) → допустимо; 0 children при synthetic
  fill-proven-final+Partial fixture → contradiction; ровно STOP+TAKE → attributable pair; лишние/
  дублирующиеся/неопознанные children → ambiguous, все варианты по отдельности.
- Атрибуция по `parentOrderLinkId` не путает children чужого entry orderLinkId (в т.ч. соседнего
  same-side cycle на synthetic multi-owner scope) со своими.
- Decode-слой: payload-shape тесты против фикстур реального Bybit V5 response для Partial-materialized
  children (после technical spike).
- Mapper: `tpslMode: "Partial"` payload-shape тесты, изолированные от `mapEntryPackageToBybit()`'s
  production пути — регрессия существующих `entryPackageApplicationService.test.ts`/
  `bybitOrderMapper`-тестов подтверждает production mapping не изменился.
- Регрессия `protectionApplicationService.test.ts` — без изменений.

**Зависит от.** Change 1 (own entry orderLinkId/fill facts как якорь атрибуции).

**Состояние после.** ABI умеет достоверно и строго обнаруживать/классифицировать собственные native
Partial protection children, полностью протестировано на synthetic/фикстурных данных; production entry
create и `PUT .../protection` не изменились.

**Осознанно вне scope.** Любое изменение `mapEntryPackageToBybit()`'s production payload; любой
create/cancel/replace-lifecycle для protection (Change 7); снятие любого guard (Change 8); OCO-семантика
между stop/take (предстоит подтвердить как нативную биржевую гарантию, не реализовать самостоятельно —
Change 7/8); sizing/qty-coverage-логика сверх того, что нужно для самой классификации (Change 7).

---

### Change 7 — `abi-native-partial-protection-lifecycle-v1` (переименован и переосмыслен ревизией v15; механика переписана ревизией v16 вокруг подтверждённого direct-amend поведения; старый id `abi-pair-owned-protection-execution-v1` не был предложен как OpenSpec; production-инертен — guard НЕ снимается)

**Цель.** Построить и полностью протестировать production-инертный **reconciliation lifecycle** для
native Partial protection: привести фактически наблюдаемые attributable children (Change 6) в
соответствие с желаемым protection-состоянием из `PUT .../protection`, изменяя существующие children
**in place через `POST /v5/order/amend` по exact `orderId`** — не создавая и не отменяя ордера. Guard из
Change 5 остаётся в силе; entry create остаётся на `tpslMode: "Full"` (mapping-cutover — Change 8). Тот
же принцип, что уже применён к Changes 2/3/4/6: реализация готова и протестирована заранее, активация —
отдельным, последним шагом (Change 8).

**Почему amend, не cancel/recreate (ревизия v16).** Ревизия v15 предполагала replacement через
`cancel old legs → confirm neutralized → create new pair`, с double/zero-coverage окном как центральным
риском этой схемы. Demo spike, проведённый до proposal этого change, показал, что вопрос снят иначе:
`PartialStopLoss`/`PartialTakeProfit` children можно менять in place через `/v5/order/amend` по их
`orderId` (доступному из Change 6's атрибуции) — `orderId`, `parentOrderLinkId`, `stopOrderType`,
`createType`, `tpslMode: "Partial"` все сохраняются через amend; `triggerPrice` меняется независимо на
каждой ноге; `qty` можно resize вниз и вверх, одним amend вместе с `triggerPrice`; изменение `qty` одной
ноги **автоматически синхронизирует** `qty` sibling-ноги (доказанный факт); новых children не создаётся,
дублей роли не возникает; Change 6's classifier после amend по-прежнему `attributed`; наблюдаемого окна
без активного SL не было. Cancel/recreate-модель v15 **superseded**, не расширена — сама
double/zero-coverage проблема, которую она решала, не возникает при amend.

**Четыре design/spike-вопроса, обязательные к закрытию до/во время design-фазы этого change** (перенесены
из ревизии v16, не решаются в этом документе):

1. **`take_price = null` → desired `STOP active + TAKE absent`.** Spike's собственный cleanup-шаг
   показал: cancel одной attached-ноги может задеактивировать sibling-ногу тоже — то есть "просто cancel
   take-ногу, оставить stop" не доказанно безопасно как механизм. Нужен отдельный doказанный способ
   получить это desired-состояние (amend take-ноги во что-то нейтральное? другой Bybit-примитив? нечто
   третье) — до implementation, не после.
2. **Triggered/race между read и amend.** Если между `resolveOwnAttachedProtection()`'s чтением и
   отправкой amend старая нога уже trigger/fill/deactivate на бирже — amend не должен слепо создавать
   replacement поверх этого. Нужна fresh-evidence дисциплина: повторное чтение непосредственно перед
   amend и/или после него, с fail-closed/terminal интерпретацией при любом расхождении.
3. **Multi-fill representability.** Change 7 не доказывает и не предполагает: auto-resize существующей
   пары при incremental fill, появление additional child pairs, или что single-pair-per-parent остаётся
   верным при multi-fill. Reconciliation ведётся против того, что Change 6's classifier **реально
   способен представить** сегодня (`none`/`attributed`/`ambiguous`-с-конкретной-причиной) — если реальная
   форма state выходит за пределы этого представления, fail closed, а classifier расширяется отдельно,
   только по доказанному evidence, никогда заранее речи.
4. **OCO-after-amend — `NOT PROVEN`.** Spike не проверял, гарантирует ли Bybit атомарную нейтрализацию
   sibling-ноги при исполнении одной ноги **после** того, как обе ноги прошли через amend. Это отдельный
   evidence-item, нужный до Change 8/cutover только если Change 8's close/activation-semantics будут на
   него полагаться (см. Change 8's Future note) — сам ABI не проектирует OCO-engine взамен.

**Что меняется.**
- `ProtectionApplicationService`'s **новый** (не production-decision) code path — reconciliation, не
  replacement:
  1. refresh own cumulative fill facts (Change 1: `early_execution_observation`/`isFillFactFinal`);
  2. `resolveOwnAttachedProtection()` (Change 6) — fresh read of actual attributable children;
  3. если actual уже соответствует desired (`stop_price`/`take_price`/`qty = own cumulative_filled_qty`)
     в пределах существующей already-satisfied semantics — no-op success;
  4. если отличается — **amend** существующих native children по их exact `orderId` (никогда create,
     никогда cancel — кроме design-вопроса 1's ещё не решённого take-absent случая);
  5. fresh bounded read-back (не переиспользование pre-amend evidence);
  6. success только если: attribution всё ещё держится (children всё ещё принадлежат тому же parent);
     stop trigger соответствует desired; take trigger соответствует desired, если take по desired должен
     существовать; stop/take qty соответствует current own cumulative exposure на обеих ногах (pair-wide
     инвариант, см. ниже);
  7. query/amend race, terminal-нога вместо ожидаемой live, любая ambiguity Change 6's classifier'а, или
     inconclusive read-back — fail closed, никогда слепой replacement.
- **Pair-wide qty invariant, не заранее навязанная optimization strategy.** Подтверждённый факт: amend
  `qty` одной ноги синхронно меняет `qty` sibling-ноги — design обязан описывать желаемый финальный
  инвариант (`effective stop coverage == effective take coverage == own cumulative fill`), а не заранее
  выбирать конкретный минимальный write-plan (одна amend-транзакция на пару vs. на ногу, что именно
  amend'ить при изменении только одной цены) — это решается в design/proposal-фазе этого change, не
  здесь.
- **Production-decision path `ProtectionApplicationService.process()` не переключается** — существующий
  `setTradingStop`/`tpslMode: "Full"` путь и `shared_scope_protection_unsupported`-guard для multi-owner
  scope остаются ровно как сегодня. Новый reconciler существует как готовый, полностью протестированный,
  но не вызываемый production-путём code path — тесты обращаются к нему напрямую.
- Явно фиксируется: этот change **сознательно не активирует** multi-owner protection и не переключает
  entry-mapping в production.

**Какие инварианты отменяются/заменяются.** Ни один production-наблюдаемый — только появляется новый,
полностью протестированный, но ещё не подключённый к production-decision code path.

**Новые инварианты.** "Reconciliation native Partial protection одного cycle меняет существующие children
in place по их exact `orderId`, никогда не создавая и не отменяя ордера для достижения desired
same-role-pair state (кроме design-вопроса 1's take-absent случая)." "`effective stop coverage ==
effective take coverage == own cumulative fill` — финальный инвариант, конкретный write-plan к нему —
design-фаза." "Amend/read-back: fail closed при неоднозначности или fresh-evidence-расхождении, зеркалит
entry-package's bounded confirmation дисциплину."

**Затрагиваемые слои.** `src/services/protection/protectionApplicationService.ts` (добавляется новый
reconciler, существующий production-decision path не меняется). Не расширяет `CloseApplicationService`
(Change 8), не меняет `bybitOrderMapper.ts`'s production mapping (Change 8).

**HTTP-контракты.** `PUT .../protection` — форма и **наблюдаемое поведение** не меняются вообще (в т.ч.
`shared_scope_protection_unsupported` из Change 5 продолжает возвращаться для multi-owner scope).

**Обязательные тесты.**
- Amend существующей native Partial пары на новые `triggerPrice`/`qty` (synthetic fixture с уже
  materialized children из Change 6's фикстур) — итоговое attributable state доказано тестом
  соответствовать desired на обеих ногах, не предполагается.
- Pair-wide qty invariant: amend одной ноги, sibling's qty читается уже синхронизированным в
  read-back — тест не предполагает синхронизацию, проверяет её на fixture-уровне.
- Два same-side cycle с разными native Partial парами на одном physical scope (synthetic, reconciler
  вызывается напрямую, минуя production-decision path): обе атрибутируются и reconcile'ятся независимо,
  каждая — по своему own entry orderLinkId через `parentOrderLinkId`.
- Fresh-evidence/race сценарий (design-вопрос 2): между read и amend нога стала terminal на synthetic
  fixture — reconciler fail closed, не отправляет amend поверх устаревшего evidence.
- Bybit reject/ambiguous-classification/inconclusive-read-back сценарии — bounded retry, fail closed при
  неоднозначности, никогда "предположим, что сработало".
- Already-satisfied short-circuit для native Partial (обнаруженное state уже соответствует желаемому —
  no-op, без amend-вызова).
- Регрессия `protectionApplicationService.test.ts` для **существующего** production-decision path —
  байт-в-байт без изменений (включая guard-отказ для multi-owner scope).

**Зависит от.** Change 6 (атрибуция/классификация — включая `orderId`, необходимый для amend), Change 1
(own fill facts).

**Состояние после.** Полный, протестированный reconciliation lifecycle для native Partial protection
через direct amend существует и доказан на synthetic-данных; `PUT .../protection` в production продолжает
вести себя идентично состоянию до Change 6. Design-вопросы 1 (take-absent) и 4 (OCO-after-amend) либо
доказаны в design-фазе этого change, либо явно зафиксированы как остающиеся `NOT PROVEN` с прямыми
последствиями для Change 8's scope.

**Осознанно вне scope.** Переключение production entry-mapping `Full → Partial`; снятие Change 5's
guard; снятие `shared_scope_protection_unsupported`; интеграция с close (все — Change 8); поддержка
opposite-side; собственная ABI-side OCO-реализация (design-вопрос 4 — доказать биржевую гарантию, не
строить замену ей); доказательство конкретной multi-fill auto-resize/additional-pairs семантики
(design-вопрос 3 — reconcile против доказанного, не против предположенного).
**[Future note, зафиксировано ревью Change 2, актуально после v15/v16]** Долгосрочно protection
принадлежит cycle, а не физической позиции, и должна следовать за `exposure_fraction` этого cycle: как
только появится настоящий partial close (`exposure_fraction < 1`, вне текущей программы), успешное
partial close того же cycle обязано соответственно уменьшить qty его native Partial protection — тот же
amend-based reconciler, который уже приводит coverage к `own cumulative_filled_qty` после fill, симметрично
приводит его к меньшему значению после partial close — resize-политика при partial close этим change не
проектируется, только фиксируется как уже совместимый со своим reconciliation-инвариантом сценарий.

---

### Change 8 — `abi-native-partial-protection-cutover-v1` (переименован ревизией v15; старый id `abi-pair-owned-protection-close-cleanup-v1` не был предложен как OpenSpec; единственная Activation программы — снимает Change 5's guard, см. ревизии v14/v15)

**Цель.** Единственный, маленький, полностью контролируемый coordinated cutover: переключить entry
mapping с `tpslMode: "Full"` на `"Partial"`, включить native Partial protection lifecycle из Change 7,
снять Change 5's temporary admission guard и `shared_scope_protection_unsupported`, и связать close с
native Partial children — всё одним change, той же гарантией "ни один applied change не оставляет
систему в небезопасном промежуточном состоянии", что уже применена к Change 5. Это единственный change
во всей protection-цепочке, меняющий production-наблюдаемое поведение — то же место в последовательности,
что Change 5 занимает для базового ownership.

**Что меняется.**
1. **Entry create mapping**: `mapEntryPackageToBybit()` (`bybitOrderMapper.ts:107-131`) переключается с
   `tpslMode: "Full"` на `"Partial"` (payload-форма подготовлена и протестирована в Change 6, здесь
   впервые подключается к production `createOrder()`-пути).
2. **`ProtectionApplicationService`**: production-decision path переключается на lifecycle из Change 7
   для multi-owner scope; `shared_scope_protection_unsupported`-guard из Change 5 снимается.
3. **`EntryPackageApplicationService.createOrder()`**: Change 5's temporary admission guard (единственный
   блок, явно закомментированный "TEMPORARY... Change 8 removes this") удаляется —
   `classifyScopeAdmission()`'s уже полностью корректный и протестированный результат (`empty`/
   `same_side` claim, `opposite_side`/`corrupt` conflict) впервые становится production-decision, не
   только internal classification.
4. **`CloseApplicationService`**: при durable close cycle нейтрализует own remaining entry (уже
   существующий cancel-entry-order-first паттерн, Change 2) **и** own attributable native Partial
   children (обнаруженные через Change 6's атрибуции). **[Ревизия v16]** Change 7 больше не строит
   отдельные "cancel-примитивы" — его reconciler работает через amend, не cancel/create — значит close's
   собственная нейтрализация своих children это отдельный, собственный примитив этого change (прямой
   Bybit cancel по exact `orderId`, тем же паттерном, что уже применяется к entry-ордеру в close-execution),
   не переиспользование чего-либо из Change 7. До закрытия own resolved exposure (Change 2:
   `exposure_fraction = "1"`). `terminal_closed` гейтится на **оба** постусловия: (а) exposure этого cycle
   закрыта, (б) own attributable protection children этого cycle неактивны (отменены, исполнились, или
   изначально отсутствовали).

**Какие инварианты отменяются/заменяются.** Temporary guard Change 5 ("любой другой active record →
conflict") — снимается: production claim впервые следует `classifyScopeAdmission()`'s полной семантике
(`empty`/`same_side` → claim, `opposite_side`/`corrupt` → conflict). Временный инвариант Change 5
("protection для scope с >1 owner фейлится закрыто") — снимается. Постусловие close-execution
("terminal_closed требует closed exposure AND no attributable active entry-order remainder")
расширяется own attributable protection children.

**Новые инварианты.** "Entry create прикрепляет `tpslMode: "Partial"` protection, атрибутируемую
per-cycle через `parentOrderLinkId`, а не position-level `"Full"`." "Physical scope может честно
обслуживать несколько same-side cycles одновременно — каждый со своей независимо атрибутируемой
protection и корректной close-очисткой."

**Затрагиваемые слои.** `bybitOrderMapper.ts` (mapping switch), `entryPackageApplicationService.ts`
(guard removal), `protectionApplicationService.ts` (guard removal, production path switch),
`closeApplicationService.ts` (protection-children cleanup).

**HTTP-контракты.** `PUT .../entry-package`, `PUT .../protection`, `POST .../close` — форма не меняется.
`shared_scope_protection_unsupported` больше не возвращается (contract narrows back — обратно
совместимо).

**Обязательные тесты.**
- Два same-side entry-package от разных cycles на одном scope оба claim успешно и сосуществуют (первый
  реальный production multi-owner тест всей программы).
- Каждый из двух cycles получает свою native Partial protection пару, атрибутированную независимо через
  `parentOrderLinkId == own entry orderLinkId`.
- Close одного cycle отменяет именно его native Partial children, не трогая соседний same-side cycle.
- `terminal_closed` не достигается, пока own attributable protection children этого cycle ещё
  живы/неоднозначны.
- Opposite-side claim по-прежнему conflict (регрессия admission).
- Single-owner регрессия: `tpslMode: "Partial"` на единственном owner ведёт себя эквивалентно
  (не обязательно байт-в-байт — задокументировать любое намеренное отличие от текущего `"Full"`-поведения,
  та же дисциплина, что риск §6 п.7 уже требовал).
- Полная регрессия существующих тестов, не относящихся к multi-owner activation.

**Зависит от.** Change 7 (готовый lifecycle), Change 6 (mapping/атрибуция), Change 5 (guard, который
снимается), Change 2 (close pipeline, расширяется).

**Примечание по объёму.** Если в ходе design-фазы Change 6/7 выяснится, что cancellation-логика
тривиальна, Change 8 можно слить с Change 7 в один change — но правило "guard снимается только после
того, как close уже умеет neutralize protection children" при слиянии сохраняется как внутренний порядок
шагов этого объединённого change, а не отменяется. По умолчанию держим отдельно как более безопасный и
проще review-ируемый вариант.

**Состояние после.** Полная реализация целевой архитектуры: long+long и short+short полностью и честно
поддержаны, каждый cycle — с независимой, нативно-атрибутированной protection и корректной уборкой при
close; long+short остаётся запрещённым, пока жива противоположная exposure. Ни один из applied changes
1–8 не проходил через небезопасное промежуточное production-состояние.

**Осознанно вне scope.** Полноценный portfolio/netting engine; hedge mode; opposite-side coexistence.
**[Future note, зафиксировано ревью Change 2, актуально и после v15/v16]** Этот change покрывает "manual
close A neutralizes A's own protection children" — автоматическая биржевая OCO-нейтрализация (take-нога
исполнилась → sibling stop-нога того же parent автоматически снимается биржей, и наоборот) — это гипотеза
о нативном биржевом поведении. Change 6's spike подтвердил attribution/amend-механику, но **не** проверял
OCO именно после amend (Change 7's design-вопрос 4, ревизия v16) — эта гипотеза остаётся `NOT PROVEN`.
Если Change 8's close/activation-semantics полагаются на неё, доказательство нужно до apply Change 8, не
предполагается здесь; ABI не реализует собственный OCO-engine взамен.

---

## 4. Dependency graph

```
Change 1 (foundation: exposure state)
   ├──> Change 2 (close, owner-aware)         ──┐
   ├──> Change 3 (open-position, owner-aware) ──┤
   └──> Change 4 (recovery, owner-aware)      ──┤
                                                 ├──> Change 5 (foundation: admission/replay mechanics, production guard stays up)
                              (2,3 напрямую;     │        │
                               4 — по соглас-    │        ├──> Change 6 (foundation: native Partial attribution, mapping stays Full)
                               ованности)        │        │        │
                                                  │        │        └──> Change 7 (native Partial reconciliation lifecycle via amend, guard НЕ снимается)
                                                  │        │                 │
                                                  │        │                 └──> Change 8 (cutover: Full→Partial + close-cleanup + единственная Activation: снимает Change 5's guard)
                                                  │        │                          ▲
                                                  └────────┴──────────────────────────┘ (Change 8 также зависит от Change 2)
```

Текстово: 1 → {2, 3, 4} (параллельно возможны) → 5 (требует 1,2,3, желательно 4; foundation, не activation
— ревизия v14) → 6 (требует 1, может идти параллельно с 2/3/4/5; foundation: native Partial attribution,
mapping остаётся Full — ревизия v15) → 7 (требует 6, 5, 3; native Partial reconciliation lifecycle через
direct amend, production-инертен — ревизия v16) → 8 (требует 7, 2; единственная Activation программы:
mapping cutover Full→Partial + guard removal).

---

## 5. Какие существующие OpenSpecs должны быть изменены/superseded/удалены

- **`position-scope-exclusivity`** — **superseded** Change 5. Центральный инвариант заменяется. Спеку не
  удаляем физически (история), но переводим в архивный/historical статус, а действующей capability
  становится новая (`virtual-exposure-ownership` или аналог).
- **`open-position-resolution`** — **изменяется** Change 3: `position_open` определение (aggregate
  existence → fill-derived) и avgPrice/first_fill sourcing заменяются (см. Change 3 выше; HTTP
  wire-контракт остаётся прежним). `first_fill_at_ms` остаётся ABI's own raw attributable first-fill
  timestamp — ABI не нормализует его к strategy bar и не знает timeframe/grid (v9-коррекция; эта
  нормализация — отдельная будущая работа Runtime через `FrozenExecutedReceipt`, не ABI). Появится ли
  на correlation-записи новое additive durable поле, и какое — открытый design-вопрос Change 3, не
  решено здесь. Остальное сохраняется.
- **`close-execution`** — **изменяется дважды**: Change 2 (ключевой разворот в источнике qty **и**
  публичный HTTP-контракт — `DELETE .../open-position` заменяется на `POST .../close` с
  `exposure_fraction`), затем Change 8 (дополнительное постусловие про protection-ордера); остальное
  (cancel-entry-order-first, unsupported_exchange_scope, идемпотентность) сохраняется без изменений.
- **`protection-execution`** — **изменяется четырежды**: малое дополнение в Change 5 (guard), additive
  read/attribution foundation в Change 6 (native Partial classification primitives, без изменения
  поведения — mapping остаётся Full; переосмыслен ревизией v15), новый native Partial reconciliation
  lifecycle через direct amend в Change 7 (production-инертно, наблюдаемое поведение не меняется;
  механика переосмыслена ревизией v16), и наконец практическая замена production-decision path в
  Change 8 (guard снимается, включая mapping cutover Full→Partial).
- **`entry-cycle-recovery-resolution`** — **изменяется** Change 4 (атрибуционная логика), остальное
  (dual-query bounded retry, legacy pending_action guard, read-only гарантия) сохраняется.
- **`entry-package-execution`** — **дополняется** Change 1 (новые additive-поля/их заполнение,
  переиспользующее существующие `cumExecQty`/`avgPrice` точки чтения в `packageConfirmation.ts`) и
  **изменяется** Change 8 (`mapEntryPackageToBybit()`'s `tpslMode` mapping switch `Full → Partial` —
  единственное production-наблюдаемое изменение этой capability во всей программе; переосмыслено
  ревизией v15). Change 6 добавляет только read-only decode/attribution primitives поверх уже
  существующей order identity — не новые orderLinkId-роли и не новый create/cancel semantics; основной
  текст (order identity, create/cancel semantics, confirmation) не меняется ни Change 6, ни Change 1.
- **`abi-position-management-api`** — **wire-level изменяется в Change 2** (close: `DELETE
  .../open-position` → `POST .../close`, новое request body `exposure_fraction`, новая
  error-таксономия для non-canonical fraction — не только prose); protection-часть спеки — только
  текстовые правки prose в Changes 5, 8 (пояснить, что значения относятся к доле cycle).
- **`abi-open-position-lookup-api`** — **только текстовые правки** prose (без изменения wire-схемы) в
  Change 3 — пояснить, что значения относятся к доле cycle, а не к физической позиции целиком. Явно
  зафиксировать, что `GET .../open-position` не приобретает quantity-поле и не меняет форму ни на одном
  шаге этой программы, включая Change 2.
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

2. **[Закрыто ревизией v6] Политика допуска дрейфа и tolerance-алгоритм.** Исходная формулировка этого
   риска предполагала сравнение `sum(ABI-resolved exposure)` vs. живой aggregate с неким tolerance —
   design-фаза Change 2 (см. ревизию v6 и corrected `design.md`) показала, что это сравнение само по
   себе небезопасно как success-proof (aggregate delta не различает "мой close" от активности соседа), а
   не только неточно откалибровано. Корректная модель устраняет сравнение целиком: success доказывается
   исключительно собственным close-ордером cycle, подтверждённым по своей own identity; aggregate
   используется только один раз до отправки для side/existence-санити, никогда как success-gate.
   Global drift-tolerance config полностью убран из Change 2. Cross-owner aggregate reconciliation как
   отдельная observability-проверка (не success-gate) остаётся возможным будущим доп.-change, если
   реальная эксплуатация докажет необходимость — не введена speculatively.

3. **Таксономия ошибок.** Opposite-side rejection, protection-guard для shared scope и новый
   reconciliation-required код для close можно отдавать как существующий `internal_error` (не меняя
   "закрытый словарь" ошибок) либо ввести точные новые коды (лучше для наблюдаемости/дебага, но формально
   это additive-изменение текста closed-vocabulary таблиц в
   `abi-position-management-api`/`abi-entry-package-api`). Нужно решение до Change 5.

4. **[Закрыто для Change 6 ревизией v16; Change 7's собственные вопросы — риск 14]** Технические детали
   нативной Bybit `tpslMode: "Partial"` attached-protection модели, изначально сформулированные для
   Change 6/7 вместе, разделены после Change 6's apply. Для Change 6: response shape для materialized
   children, parent-attribution field (`parentOrderLinkId`), STOP/TAKE-дискриминатор (`stopOrderType`) —
   **подтверждены** Demo spike'ом, Change 6 applied и archived на этой основе. Для Change 7: остававшиеся
   вопросы (OCO-нейтрализация sibling-ноги, повторный query/replace на уже-materialized children) —
   перенесены и расширены в риск 14 (ревизия v16) по итогам отдельного Change 7 Demo spike'а, который уже
   подтвердил direct-amend механику отдельно от OCO-вопроса.

5. **Observability пробел.** Сегодня нет метрик/событий, различающих scope contention или multi-owner
   состояние (`src/observability/events.ts` не имеет соответствующих полей). Без добавления полей
   (owner count, side, drift, terminal-refresh-события) новый инвариант станет операционно невидимым —
   рекомендуется добавить как часть Change 1 (структура) и Change 5 (события активации).

6. **Философский разворот в close (Change 2).** Явно зафиксировать как осознанное решение: до сих пор
   close принципиально не доверял ABI-recorded количествам именно чтобы избежать дрейфа; теперь для
   multi-owner случая это единственный физически возможный источник, и только после верификации
   терминальности собственного entry-ордера cycle. Это решение нужно явно одобрить, а не оставлять
   неявным побочным эффектом. **[Уточнено v6]** сам факт resolved quantity не единственное новое —
   не менее важно, что close получает **собственную атрибутируемую order identity** (тот же паттерн, что
   уже используется entry-package create/cancel), чтобы retry/restart после потери ответа не мог
   отправить второй close-ордер и случайно затронуть чужую exposure соседнего cycle на том же scope.

7. **[Переформулирован ревизией v15] Совместимость protection в single-owner случае (Change 8).**
   Нужно решить: остаётся ли `tpslMode: "Full"` mapping'ом для entry create безусловно (никакого cutover
   вообще, пока scope реально не разделён несколькими owners — переключение в `"Partial"` происходит
   только для scope, где реально join второй same-side owner) или Change 8 безусловно переключает
   mapping на `"Partial"` для всех scope, включая сегодняшний mainline single-owner случай
   (единообразнее — один mapping path вместо двух — но меняет production-наблюдаемое поведение даже там,
   где multi-owner никогда не возникает). Решение — design-фаза Change 8. (Исходная формулировка этого
   риска — про `setTradingStop`-fallback vs. ABI-generated conditional-ордера, отклонённый вариант B —
   больше не актуальна.)

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

11. **Скоординированный Runtime rollout (Change 2).** Change 2 меняет публичный close-контракт
    (`DELETE .../open-position` → `POST .../close` с `exposure_fraction`) — это единственный change во
    всей программе с внешней cross-repo зависимостью. ABI не должен деплоиться в production раньше или
    без синхронизированного Runtime-изменения (`ClosePositionCommand` должен уметь отправлять
    `exposure_fraction`). Открытые вопросы, не решённые здесь: механизм атомарного/скоординированного
    rollout (одновременный deploy, временное окно совместимости, feature-flag), кто владеет
    Runtime-side OpenSpec change и его change-id, порядок review между двумя репозиториями. Это должно
    быть закрыто до начала apply Change 2, отдельно от чисто-ABI-технических рисков выше.

12. **HTTP contract migration / decommission без backward-compat alias (Change 2).** Решено не сохранять
    старый `DELETE .../open-position` как alias "без доказанной необходимости" — но это осознанный
    breaking change для любого клиента (включая сам Runtime до его coordinated update), а не
    additive-расширение, как большинство остальных HTTP-правок этой программы. Нужно явно
    зафиксировать (до apply Change 2): допустим ли короткий переходный период с обоими endpoint'ами
    одновременно, или ожидается атомарный cutover; кто и как валидирует отсутствие иных потребителей
    старого `DELETE`, кроме самого Runtime.

13. **[Future-only, не открытый риск сейчас] Individual-execution dedup и multi-channel convergence.**
    Зафиксировано по итогам архитектурного ревью execution/reconciliation паттернов (FIX order/execution
    model, Bybit orderLinkId/order-status/execution primitives, NautilusTrader, LEAN, Hummingbot —
    изучены только как проверка инвариантов, не скопированы). Сегодня ABI подтверждает исполнение
    исключительно через cumulative `cumExecQty`/`order_status` одного REST-запроса
    (`confirmEntryPackage`), никогда не применяет individual execution/trade events инкрементально — это
    верно и для entry, и для close (Change 2), поэтому fill-level deduplication сейчас не нужна ни там,
    ни там. Если в будущем ABI начнёт принимать individual execution events из нескольких каналов
    (например, REST reconciliation вперемешку с гипотетическим WebSocket execution stream), они должны
    идемпотентно дедуплицироваться по стабильному exchange execution/trade identity, а оба канала
    обязаны сходиться к одному state machine, а не стать двумя независимыми source of truth. Ни ledger,
    ни WebSocket-интеграция, ни background polling не вводятся ни этим ревью, ни Change 2 — чисто
    forward-note для гипотетической будущей capability, не для реализации сейчас.

14. **[Новый риск, ревизия v16] Change 7's четыре design/spike-вопроса, обязательные до/во время
    design-фазы.** Отдельный Demo spike (после Change 6 applied) подтвердил direct-amend механику
    (`orderId`/`parentOrderLinkId`/`stopOrderType`/`createType`/`tpslMode` сохраняются через
    `/v5/order/amend`; `triggerPrice` меняется независимо на каждой ноге; `qty` resize вниз/вверх;
    изменение `qty` одной ноги синхронизирует sibling's `qty`; Change 6's classifier остаётся
    `attributed` после amend) — этот риск не про саму amend-механику (закрыт), а про четыре
    оставшихся вопроса, ни один из которых spike не решал:
    - **Take-absent construction.** `take_price = null` в desired state требует получить
      `STOP active + TAKE absent` — spike's cleanup показал, что cancel одной ноги может
      задеактивировать sibling тоже, значит "cancel take-ногу" не доказанно безопасен как механизм.
      Нужен доказанный способ до implementation.
    - **Triggered/race fresh-evidence дисциплина.** Между `resolveOwnAttachedProtection()`'s чтением и
      amend старая нога может уже trigger/fill/deactivate на бирже — reconciler не должен слепо
      amend'ить/replacement'ить поверх устаревшего evidence.
    - **Multi-fill representability.** Change 7 SHALL NOT предполагать auto-resize существующей пары,
      additional child pairs, или single-pair-per-parent при incremental fills — reconciliation ведётся
      против того, что Change 6's classifier реально способен представить; расширение classifier'а —
      только по доказанному evidence.
    - **OCO-after-amend — `NOT PROVEN`.** Spike не проверял, гарантирует ли Bybit атомарную
      нейтрализацию sibling-ноги при исполнении одной ноги после amend. Отдельный evidence-item,
      нужный до Change 8/cutover только если Change 8's close/activation-semantics будут на него
      полагаться (см. Change 8's Future note) — ABI не проектирует собственный OCO-engine взамен.

    Полная truth table и design decisions по всем четырём — design-фаза Change 7, не здесь.

---

## 7. Финальный рекомендуемый порядок реализации и smoke-verification

0. **Housekeeping (вне программы):** заархивировать `abi-entry-package-exchange-canonical-confirmation-v1`
   в `openspec/changes/archive/`, чтобы baseline специй был чист.
1. **Закрыть риски §6** (механизм refresh для cumulative_filled_quantity/avgPrice, точная величина
   допуска дрейфа/tolerance-алгоритм, таксономия ошибок, нативная `tpslMode: "Partial"` response shape и
   её technical spike (риск 4 — закрыт для Change 6 ревизией v16), Change 7's четыре
   take-absent/race/multi-fill/OCO-after-amend вопроса (риск 14, ревизия v16), single-owner
   mapping-политика в protection (риск 7, переформулирован v15), **координация Runtime rollout и
   decommission-план для `DELETE .../open-position`** — риски 11–12) — до написания первого proposal.
2. **Change 1** → apply → регрессия всего существующего test suite (ожидается 0 поведенческих изменений)
   → smoke: restart процесса на существующих данных, подтвердить, что single-owner scopes резолвятся
   идентично; отдельно smoke на реальном частичном fill на Bybit Demo — убедиться, что
   `cumulative_filled_quantity` действительно продолжает расти после первого partial-fill наблюдения.
3. **Change 2** → apply (**вместе со скоординированным Runtime-side change** — см. риск 11) →
   синтетические multi-owner и partial-fill тесты + полная регрессия close → smoke на Bybit Demo:
   `POST .../close` с `exposure_fraction="1"` для обычного single-cycle сценария даёт тот же итоговый
   результат (physical zero, `terminal_closed`), что даёт сегодняшний `DELETE`-путь; отдельно —
   `exposure_fraction`, отличная от `"1"` (например `"0.5"`), отклоняется fail-closed без exchange-вызова;
   отдельно — подтвердить, что `DELETE .../open-position` действительно снят (или, если принят
   переходный период по риску 12, ведёт себя ровно так, как зафиксировано в его решении), и что
   `GET .../open-position` не изменился; отдельно (synthetic multi-owner fixture, не Demo) — убедиться,
   что повторный `POST .../close` для cycle, чей предыдущий close-ордер уже durably записан
   (`close_order_link_id`), никогда не отправляет второй Bybit-ордер, пока судьба первого не
   подтверждена по его own identity.
4. **Change 3** → apply → аналогично → smoke: `GET open-position` на реальной Demo-позиции, включая
   момент, когда entry-ордер ещё partial — `average_entry_price` в ответе актуален, а не устаревший, и
   `position_open = true` уже при живом `PartiallyFilled` собственном ордере с ненулевым fill; после
   полного fill убедиться, что `first_fill_at_ms` — это собственный trustworthy raw attributable
   first-fill timestamp этого cycle (own-order-sourced, стабильный при повторных запросах), а не
   пересчитывается через какую-либо candle-grid/bar-normalization внутри ABI — эта нормализация
   явно не входит в ABI's scope (v9); ответ по-прежнему не содержит quantity-поля.
5. **Change 4** → apply → smoke: убить/перезапустить процесс посреди активного trade cycle (в т.ч. с
   partial fill) на Demo, подтвердить recovery-state не изменился относительно baseline.
6. **Change 5 (foundation, не activation — ревизия v14)** → apply → smoke на Bybit Demo: **никакого
   same-side coexistence теста здесь** — это шаг сознательно без production-риска, guard из Decision 1
   сохраняет ровно сегодняшнее поведение. Вместо этого smoke подтверждает регрессию: второй
   entry-package (любой стороны, включая same-side) на уже занятый scope по-прежнему отклоняется, как и
   сегодня; self-repeat/retry для собственного scope по-прежнему проходит без ложного conflict;
   `PUT protection` для единственного owner ведёт себя байт-в-байт как раньше. Multi-owner classification/
   replay/protection-guard-логика уже полностью протестирована модульно на synthetic fixtures (часть этого
   change), но не в Demo smoke — на Demo её физически нельзя вызвать, пока guard стоит.
7. **Change 6 (native Partial attribution foundation — ревизия v15)** → apply → smoke: атрибуция и
   классификация native Partial children работают изолированно на synthetic/фикстурных данных (никакого
   реального Partial-fill на Demo — entry-mapping там всё ещё Full); `PUT .../protection` и entry create
   ведут себя байт-в-байт как до этого change.
8. **Change 7 (native Partial reconciliation lifecycle через direct amend — ревизии v15/v16)** →
   apply → smoke: reconciler корректно работает при прямом вызове (synthetic fixtures, не через
   production `PUT .../protection`) — включая amend существующей пары на новые triggerPrice/qty, с
   доказанным pair-wide qty sync и без слепого replacement на fresh-evidence-race; production-путь
   `PUT .../protection` по-прежнему `setTradingStop`/`tpslMode: "Full"`, guard-отказ для multi-owner
   scope не изменился — явно проверить, что ничего не изменилось для пользователя. Take-absent
   (design-вопрос 1) и OCO-after-amend (design-вопрос 4) — либо доказаны в design-фазе и покрыты smoke,
   либо явно задокументированы как остающиеся `NOT PROVEN` для Change 8.
9. **Change 8 (единственная Activation программы — ревизии v14/v15)** → apply → smoke на Bybit Demo:
   entry create теперь прикрепляет `tpslMode: "Partial"`; Change 5's admission guard снят — впервые в
   программе два same-side entry-package на одном symbol от разных trade cycles оба успешно создаются и
   сосуществуют; третья opposite-side попытка отклоняется; у двух same-side cycles независимая native
   Partial protection, каждая атрибутирована через свой `parentOrderLinkId`; close одного cycle отменяет
   именно его attributable protection children и закрывает его долю, второй cycle остаётся нетронутым;
   `terminal_closed` достигается только после обоих постусловий.

Каждый шаг — самостоятельно принимаемый OpenSpec change с собственным proposal/design/tasks, отдельным
review и отдельным apply — согласно ограничению не смешивать несколько архитектурных ответственностей
в одном change.
