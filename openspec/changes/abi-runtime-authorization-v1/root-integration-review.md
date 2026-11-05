# Ревью интеграции: обычный Deploy → LOCKED → AUTHORIZED → Trading READY

Статус: пользователь разрешил Apply этой схемы. Реализация опубликована для приёмки в ABI draft PR #55, bbb_stack #105 и Runtime #47 (только тесты поверх #46). Основа — компоненты #52/#53/#54; код #51 не используется. Рабочий Demo не переключался. Результаты и границы проверок — в tasks.md.

## Минимальная интеграция внутри существующего ABI

1. В config убрать хранение/чтение BYBIT_API_KEY и BYBIT_API_SECRET и стартовую ошибку risk sizing без env-ключей. Сам расчёт риска не меняется: подписанное чтение баланса доступно только после авторизации. Добавить обязательный expected UID как несекретную настройку. Не принимать UID из credentials-frame и не определять ожидаемую личность по проверяемому ключу.
2. Root создаёт один socket handle с настоящим verifier из #54 и использует возвращённый authorization в обязательном CredentialsSource REST из #53. HTTP и локальные хранилища стартуют в LOCKED; socket не зависит от готовности журнала.
3. В socket handler добавить узкое уведомление root после завершения authorize/retry, когда credentials() уже доступен. AuthorizationService не меняет ответственность и не запускает observers. Уведомление не ждёт Trading READY; accepted означает только AUTHORIZED. Повтор retry при уже подтверждённой паре может повторить неуспешную проверку привязок без нового пароля. Root не запускает параллельные попытки активации. После temporary_failure он сам повторяет проверку сохранённого кандидата через один таймер 5/15/30/30… секунд. Этот же таймер повторяет assurance при unavailable, но не при подтверждённом mismatch или несовместимой policy; локальный replay не повторяется. При переходе к другой фазе backoff начинается с 5 секунд. Ручной retry остаётся диагностическим, пароль нужен один раз. Shutdown снимает таймер и отменяет выполняющуюся проверку.
4. Observers создаются после авторизации один раз. WS получает CredentialsSource и берёт одну пару непосредственно для подписи auth handshake; не хранит отдельную конфигурационную копию ключей. REST reconciler использует тот же рабочий REST, без проверки env-ключей. Его worker и WS reconnect сохраняются. Публичный heartbeat может запускаться сразу; его состояние не блокирует исполнение.

## Журнал: существующий путь без предварительного рефакторинга

Конкретный минимальный вариант не требует изменения lifecycleEvents.ts: вызвать существующий replayCorrelationStore(repository, localReadiness) без activation. Он уже выполняет replay и cleanup, обрабатывает отказы и сохраняет их в переданном EntryPackageReadiness. Сохранить Promise этого однократного вызова в root.

После авторизации root ожидает тот же Promise. Если localReadiness.isReady=false, торговля остаётся неготовой; биржевая проверка не вызывается. Если true — root отдельно вызывает существующую assureConfiguredActiveBindings() с актуальными active records. Повтор после сетевой ошибки повторяет только assurance, не replay/cleanup. Никаких новых типов результатов фаз и новой capability журнала.

Корреляционные observers используют localReadiness, а торговый допуск — отдельную композицию:

```text
account allowed = !stopping && AUTHORIZED && ограничения account-операции
trade admitted  = !stopping && AUTHORIZED && localReadiness && bindingsVerified
```

Dry-run/liveTradingEnabled/Mainnet guard сохраняют собственную семантику. READY не означает обход этих ограничений. Ошибка assurance не отменяет AUTHORIZED и не лишает account API доступа. Backfill и WS connection не добавляются в предикат торговой готовности. Существующее локальное событие readiness_ready не трактуется как разрешение торговли; публичная готовность и отдельная диагностика исполнения используют составной предикат.

## Admission, guards и health

- В уже существующих проверках маршрутов заменить ответ о неготовности на согласованный 503 execution_not_ready до вызова use case. Использовать общий helper допуска с предикатом категории операции; account не получает зависимость от journal.
- После допуска никаких повторных проверок готовности, преобразующих результат в этот 503. Существующие mutex, подтверждения и неопределённые результаты сохраняются; очереди команд нет.
- Account routes, live guard, execution helpers и protection guard перестают проверять ключи в AbiConfig. Передаётся только факт авторизации; dry-run, liveTradingEnabled и Mainnet ограничения остаются. Не подставлять фиктивные непустые ключи в config.
- /health/live сообщает жизнеспособность HTTP. /health/ready и существующий /health показывают составную готовность исполнения. Диагностика отдельно показывает authorization, local recovery и bindings без credentials. Docker использует /health/live, поэтому LOCKED не блокирует Runtime startup.
- OpenAPI и тесты HTTP envelope согласуются с Runtime #46. Новых торговых состояний или recovery-протокола Runtime нет.

## Shutdown

Добавить начало остановки до ожидания server.close(): установить stopping, закрыть новый admission и socket listener/connections, отменить verifier и запретить поздние activation continuations. После каждого await активация проверяет stopping до создания observers и публикации готовности. Уже допущенные HTTP-команды проходят прежний drain; REST pool и используемые хранилища закрываются после него. Обработчик завершения учитывает Promise закрытия socket, без запуска новых фоновых компонентов.

## Обычный Docker Deploy в существующем bbb_stack

- Сервис abi, abi:8787, bind данных и все торговые настройки сохраняются.
- Убрать env_file bybit-demo.env именно из сервиса ABI. Прочие нужные настройки этого файла перенести явно в несекретную конфигурацию без чтения/печати ключей. Другие сервисы и их секреты не менять.
- Добавить expected UID целевого Demo-аккаунта из доверенной настройки оператора, tmpfs /run/abi-authorization с uid/gid ABI и mode 0700, равные лимиты memory/memswap и core=0. Проверить memory.swap.max=0 и режим каталога фактически внутри контейнера. Конкретный memory limit сверить с действующим потреблением ABI перед выбором, не вводить произвольное занижение.
- Healthcheck ABI перевести на /health/live. Обычный GitHub Actions Deploy сохраняется, не ждёт пароля и не вызывает age/authorize. Не исключает ABI из docker compose up и не удаляет workflow. Тесты проверяют запуск Runtime при LOCKED ABI.
- Команда на Mac находит контейнер существующего Compose-сервиса abi и вызывает доставку #54. Пароль вводится непосредственно age. Без второго ABI, новых сетей и переноса данных.

## Проверки и условия переключения

1. Локальная интеграция на подставном Bybit transport: два порядка auth/replay, повреждённый journal при AUTHORIZED, assurance retry без cleanup, отсутствие дублей observers, gate до side effects, HTTP 503 и shutdown на каждом async участке. Нет production fake accepted или нового env-fallback.
2. Docker-проверка образа и Compose: запуск без ключей при risk sizing, HTTP live=200, ready=503, authorization=LOCKED, Runtime не блокируется. Проверить tmpfs/mode/swap и отсутствие credential env/mount, не выводя значения. Restart снова LOCKED.
3. После ревью совместимого набора и отдельного разрешения на действующий Demo — read-only сверка заявок/позиций и контролируемый переход через age к AUTHORIZED, затем assurance и Trading READY без смены container ID. Перед READY обеспечить контроль существующего Runtime, чтобы проверка готовности не запускала несогласованный торговый цикл. Торговый write smoke не является частью одной лишь проверки готовности и согласуется отдельно.
4. Неверный пароль не меняет состояние. Временный verifier failure оставляет RETRY_PENDING, retry без нового пароля. Сетевой отказ assurance сохраняет AUTHORIZED и закрывает только торговую готовность. После restart требуется новая авторизация.

Сначала отдельный review PR совокупного ABI; Compose/workflow diff проверяется вместе с ним. Неработоспособные промежуточные версии не сливаются и не деплоятся. Любые merge, действующий Demo Deploy и торговый smoke требуют разрешения. Mainnet остаётся запрещённым.
