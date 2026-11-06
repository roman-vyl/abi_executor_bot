## Context

База: ABI c21ca11. OpenPositionResolutionService.resolveLiveQueryAdmissible() сначала вызывает lookupLive(), затем повторно проверяет first_fill и только потом capture. EntryCycleRecoveryResolutionService вызывает тот же REST primitive из position_open и best-effort terminal_after_fill. SQLite уже имеет readLinkForOrder()/readFactsForOrder(orderId, limit).

## Goals / Non-Goals

Единый проверяющий компонент для точного времени; неизменные live/recovery verdicts, serialization и контракты. Не менять авторизацию, торговую маршрутизацию, close, sizing или схему хранения. Никаких новых listeners, workers или REST retries. Чтение выполняет тот же процесс ABI через уже открытый ExchangeFactsStore: нет второго процесса-владельца рабочей SQLite, BEGIN IMMEDIATE для SELECT, новой очереди или блокировок.

## Decisions

### 1. Одна цепочка источников, после определения состояния

existing lookupLive/recovery proof → saved first_fill → existing REST capture → при неуспехе и доказанной терминальности entry verified SQLite executions → existing persistence/response.

Сохранённое время не перечитывается и не перезаписывается. Если закрытие произошло до lookup, existing closure/terminal handling имеет приоритет: локальный entry fill не возвращает цикл к position_open. В recovery terminal_after_fill используется тот же компонент только для существующего best-effort capture; его неуспех не превращает уже доказанное terminal_after_fill в ошибку. Все прежние status-changing writes/convergence сохраняют прежние требования.

### 2. Узкий вход и результат

Компонент получает текущую identity: instance, cycle, generation, category, symbol, подтверждённые exact orderId/orderLinkId, side/binding, терминальный exchange orderStatus и положительный окончательный cumExecQty собственного ордера из одного согласованного proof. Quantity берётся из существующего достоверного fill proof (свежего или допустимого final observation), а не planned qty, агрегатной позиции или SQLite order-state. Требуется минимально передать этот proof-context в capture, не делать новых сетевых запросов ради SQLite. Если authoritative orderId отсутствует — SQLite непригоден, сохраняется исходный неуспех REST. Нельзя брать create ACK order_id или binding_history вместо идентичности текущего доказательства.

Один optional read-only порт к существующему store; result verified(firstFillAtMs) либо unavailable(reason). Одинаковый verifier используется во всех трёх call sites; внутренние типы не являются новым API. Точные reason нужны только для безопасных тестов/диагностики, без raw payload/credentials. SQLite exception/disabled трактуются как unavailable.

### 3. Доказательство принадлежности и полноты

До любого SQLite read требуется доказанная терминальность исходного entry-ордера: Filled либо иной уже поддерживаемый окончательный статус с подтверждённым положительным исполненным объёмом. Status и cumExecQty должны принадлежать одному существующему authoritative own-order proof текущей identity; нельзя объединять старый partial cumulative snapshot с новым статусом из SQLite. Correlation status applied и запись WS о fill сами по себе не доказывают terminality. Существующий final observation допустим только по прежним правилам его повторного использования. Новых REST-запросов ради terminality не добавляем: без уже имеющегося terminal proof локальный путь недоступен.

Живые New/Untriggered/Triggered/PartiallyFilled и неизвестная терминальность исключают SQLite fallback. После неуспеха REST сохраняется прежняя branch-specific семантика без чтений SQLite. Несколько частичных исполнений уже терминального ордера разрешены, включая отменённый остаток и положительный окончательный cumExecQty. Не требуется равенство с изначальным planned/order qty: требуется равенство именно с окончательным исполненным объёмом.

Причина ограничения: при живом ордере позднее исполнение может заместить отсутствующее раннее в выборке и случайно дать ту же сумму, что устаревший cumExecQty; одно равенство не доказывает earliest. Терминальная окончательная сумма устраняет эту гонку, не требуя синхронизации REST и WS.

readLinkForOrder должен совпасть по orderId, orderLinkId, instance, cycle, generation, role=entry. Проверяется среда store; raw execution сверяется с нормализованной строкой и proof: category, symbol, orderId/orderLinkId, side, execType=Trade. Execution не всегда содержит positionIdx: отсутствующее поле не выдумывается; принадлежность slot следует из подтверждённого ордера и текущей связи, явно противоречащее поле отвергается.

Читается bounded snapshot фактов этого orderId. readFactsForOrder возвращает LIMIT без флага полноты: если length >= limit, результат консервативно непригоден и сохраняется исходный неуспех REST, даже если первые строки уже дают нужную сумму. Нельзя объявлять полноту по усечённому префиксу или добавлять неограниченный SQL scan. Достаточно существующего bounded read; новая схема/pagination framework не нужна.

Для execution-строк обязательны execId, целочисленный положительный execTime и положительный exact-decimal execQty. Дубли одного execId (WS/REST) считаются один раз только при совпадении identity/time/quantity; конфликт делает набор непригодным. Никаких Number/float или epsilon для суммы: sum(unique execQty) == confirmed cumExecQty > 0. Меньшая, большая сумма, неправильная identity, неизвестные/повреждённые execution-факты — fallback. Сопутствующие order_state строки не суммируются. Ошибку/конфликт нельзя «починить» выбором удобного подмножества.

Только после всех проверок min(execTime) становится кандидатом. receivedAt/SQLite write time/order updatedTime и bar alignment запрещены. Удерживается существующий pair mutex, запись перечитывается и проверяется на current generation/closure как раньше; SQLite не запускает replay и не определяет open/closed.

### 4. REST-first, SQLite только после неуспеха capture

Saved first_fill исключает и REST capture, и SQLite чтение. Иначе сначала выполняется прежний REST capture со всей его пагинацией и транспортными retries. При found результат используется без единого чтения SQLite, включая readLinkForOrder. Только если REST capture не дал времени, вызывается локальный verifier. Если он unavailable, сохраняется исходный неуспех REST: повторного обхода REST после SQLite нет. Для terminal_after_fill по-прежнему best-effort. Начальная live/recovery проверка состояния обязательна: её отказ не запускает timestamp fallback. Fallback не маскирует противоречия о состоянии цикла.

REST-first выбран, чтобы нормальный цикл не получал новую синхронную I/O нагрузку. Уже полученный REST неуспех не делает любую локальную запись достоверной: все identity/completeness проверки остаются обязательными.

Альтернативы: короткий retry не устраняет длительную пустоту REST; «первое полученное WS» не доказывает earliest; один новый orderId REST fallback не доказан как работающий раньше. Они не входят в изменение.

## Risks / Trade-offs

- Синхронный SELECT блокирует event loop → REST-first, адресный LIMIT и обязательный latency/WS smoke; try/catch не является deadline.
- Пропущен более ранний partial fill → полнота по уникальным qty и confirmed cumulative quantity; иначе прежний отказ.
- Поток накопил больше read-limit или facts store отключён → выигрыш недоступен, прежнее поведение сохраняется.
- Живой ордер продолжает исполняться после snapshot → SQLite путь запрещён независимо от совпадения сумм; не подгонять confirmed quantity под журнал.
- Устарела generation/наступило закрытие → существующие mutex/re-read/closure guards сохраняются.
- Факты могут оказаться непригодны во время долгой REST-пустоты → текущая доступность не гарантируется; этот спек не вводит новый recovery protocol.

### 5. Измерение задержек до Deploy

better-sqlite3 синхронен: try/catch защищает от исключения, но не ограничивает длительность SELECT. Promise.race/таймер также не прерывает заблокированный event loop. Нулевой риск не заявляется.

После реализации, до разрешения Deploy провести небольшой bounded load smoke на том же Mac/Docker Desktop и таком же bind-storage, с репрезентативным рабочим объёмом и распределением фактов по orderId. Отдельный тестовый ABI владеет только своей согласованной копией базы; реальные credentials, торговые запросы и открытие рабочей БД вторым процессом исключены. Копия — ранее согласованный consistent snapshot/экспорт владельцем; нельзя копировать живой SQLite без WAL-consistency. Использовать существующий WS recorder/write path с синтетическими пакетами, без нового production сервиса.

Сравнить baseline REST-success (SQLite calls=0) и forced REST-empty fallback при одновременных WS batch writes. Включить холодные/прогретые адресные чтения и ордера у read-limit; заранее ограничить длительность/частоту нагрузки, не нагружать работающий Demo. Записать объём базы, SQLite journal/busy настройки, число фактов/order, read-limit, длительность, частоты запросов/WS, число samples и ошибки. Метрики p50/p95/p99/max отдельно для SELECT/link read и полного verifier, event-loop lag, задержки приёма/обработки/flush WS, dropped records и backlog; сравнить с baseline. Интервал доставки WS измерять с согласованными часами или локальным монотонным instrumentation.

Максимумы, а не только среднее, и воспроизводимая команда публикуются для ревью без данных аккаунта. До отдельной оценки этих измерений Deploy не разрешается; допустимость регрессии согласуется по результатам, не выводится из успешного функционального smoke. При неприемлемой задержке текущую реализацию не выкатывать и вернуться к ревью; автоматически вводить workers/очереди нельзя.

## Migration Plan

Сейчас только документация и внешнее ревью. После отдельного Apply — ABI-only PR, unit/integration fakes, npm test/typecheck/build/OpenAPI. Любые merge, Demo deploy/smoke согласуются отдельно. Runtime/Compose остаются прежними; откат образом, без миграции данных. Mainnet не включать.
