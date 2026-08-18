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
  reduceOnly, qty = ABI-resolved authoritative exposure этого cycle (см. quantity ownership boundary,
  Change 1/2 — не отдельное mutable поле), orderLinkId по уже существующей схеме
  `entryPackageOrderIdentity.ts`). Выбран как архитектурно верный — единственный вариант с честной
  per-cycle изоляцией, переиспользует уже отработанные паттерны (order identity, bounded confirmation,
  reduceOnly semantics, которые уже использует close-execution). Долгосрочно protection тоже придёт к
  семантике `exposure_fraction` (см. ревизию v5, Change 2): "protect `exposure_fraction = 1` этого
  cycle", а не "защитить всю физическую Bybit-позицию" — Changes 6–8 этой правкой не переписываются,
  protection HTTP contract не меняется.

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
| 5 | `abi-same-side-virtual-exposure-ownership-v1` | супersedes `position-scope-exclusivity`; малый guard в `protection-execution` | **Activation #1** — базовое ownership |
| 6 | `abi-pair-owned-protection-state-foundation-v1` | новая: pair-owned protection identity/state (+ additive к `protection-execution`) | Data model/identity, без изменения поведения |
| 7 | `abi-pair-owned-protection-execution-v1` | `protection-execution` | Execution lifecycle, **production-инертно** (guard из Change 5 не снимается) |
| 8 | `abi-pair-owned-protection-close-cleanup-v1` | `close-execution` (расширение) | Close-cleanup + **Activation #2** — снимает guard |

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
same-side production activation (Change 5); opposite-side coexistence; pair-owned protection-ордера
(Changes 6–8); `first_fill`/entry-bar resolution (Change 3); recovery redesign (Change 4); Runtime,
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
  qty = ABI-resolved authoritative exposure этого cycle (per Change 1/2's quantity ownership boundary —
  `cumulative_filled_qty` once `isFillFactFinal`, не отдельное mutable поле; долгосрочно эта же
  величина соответствует "`exposure_fraction = 1` этого cycle", см. ревизию v5).
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
интеграция с close (Change 8); поддержка opposite-side. **[Future note, зафиксировано ревью Change 2]**
Долгосрочно protection принадлежит cycle, а не физической позиции, и должна следовать за
`exposure_fraction` этого cycle: как только появится настоящий partial close (`exposure_fraction < 1`,
вне текущей программы), успешное partial close того же cycle обязано соответственно уменьшить qty его
собственных stop/take-ордеров (`stop qty == take qty == оставшаяся exposure cycle`, не старая полная
величина) — resize-алгоритм этим change не проектируется, только фиксируется как инвариант, который
Change 6/7's `qty = ABI-resolved authoritative exposure этого cycle` формулировка уже совместима с ним.

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
  conditional-ордера (по данным из Change 6) до/как часть закрытия его resolved exposure (Change 2:
  `exposure_fraction = "1"` этого cycle). `terminal_closed` теперь гейтится на **оба** постусловия:
  (а) exposure запрошенного cycle закрыта (Change 2's postcondition — physical zero лишь частный
  single-owner случай), (б) собственные protection-ордера этого cycle неактивны (отменены или уже
  терминальны).
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

**HTTP-контракты.** `POST .../close` (контракт уже установлен Change 2) и `PUT .../protection` — форма
не меняется этим change. `shared_scope_protection_unsupported` больше не возвращается (contract narrows
back to fewer error cases — обратно совместимо, просто меньше 4xx-путей).

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
**[Future note, зафиксировано ревью Change 2]** Этот change покрывает "manual close A neutralizes A's
own protection orders" — но OCO-style автоматическая нейтрализация (take-нога исполнилась полностью →
sibling stop-нога того же cycle автоматически нейтрализуется, и наоборот, независимо от manual close)
нигде явно не зафиксирована в текущем описании Changes 6–8. Это открытый вопрос **design-фазы Change 7
или 8** (какая из двух — решается на месте), не решаемый и не проектируемый здесь.

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
  foundation в Change 6 (без изменения поведения), новый lifecycle в Change 7 (production-инертно,
  наблюдаемое поведение не меняется), и наконец практическая замена production-decision path в Change 8
  (guard снимается).
- **`entry-cycle-recovery-resolution`** — **изменяется** Change 4 (атрибуционная логика), остальное
  (dual-query bounded retry, legacy pending_action guard, read-only гарантия) сохраняется.
- **`entry-package-execution`** — **дополняется** Change 1 (новые additive-поля/их заполнение,
  переиспользующее существующие `cumExecQty`/`avgPrice` точки чтения в `packageConfirmation.ts`) и
  Change 6 (новые orderLinkId-роли), основной текст (order identity, create/cancel semantics,
  confirmation) не меняется.
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
   неявным побочным эффектом. **[Уточнено v6]** сам факт resolved quantity не единственное новое —
   не менее важно, что close получает **собственную атрибутируемую order identity** (тот же паттерн, что
   уже используется entry-package create/cancel), чтобы retry/restart после потери ответа не мог
   отправить второй close-ордер и случайно затронуть чужую exposure соседнего cycle на том же scope.

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

---

## 7. Финальный рекомендуемый порядок реализации и smoke-verification

0. **Housekeeping (вне программы):** заархивировать `abi-entry-package-exchange-canonical-confirmation-v1`
   в `openspec/changes/archive/`, чтобы baseline специй был чист.
1. **Закрыть риски §6** (механизм refresh для cumulative_filled_quantity/avgPrice, точная величина
   допуска дрейфа/tolerance-алгоритм, таксономия ошибок, conditional-order детали, single-owner fallback
   в protection, **координация Runtime rollout и decommission-план для `DELETE .../open-position`** —
   риски 11–12) — до написания первого proposal.
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
