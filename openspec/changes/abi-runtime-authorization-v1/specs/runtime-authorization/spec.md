## Purpose

Позволить оператору авторизовать работающий ABI после обычного деплоя, сохраняя независимость полномочий Bybit от торгового восстановления и существующий reconciliation.

## ADDED Requirements

### Requirement: One independent authorization owner
ABI SHALL иметь единственного владельца кандидата, подтверждённых credentials и состояния авторизации. Он MUST зависеть только от переданного verifier с результатами accepted, rejected и temporary_failure, без зависимости от журнала, readiness, торговых сервисов, Runtime или observers. Подтверждённая пара SHALL быть защищена от внешней мутации и доступна только после accepted. Новая совокупная версия MUST NOT читать рабочие credentials из env/config или поддерживать старый fallback.

#### Scenario: Journal recovery fails independently
- **WHEN** credentials, expected UID и права подтверждены, но торговый журнал не восстановлен
- **THEN** авторизация остаётся успешной и независимые account-запросы доступны с их существующими ограничениями
- **AND** торговые циклы остаются заблокированы необходимыми проверками торгового состояния

#### Scenario: Concurrent and repeated candidates
- **WHEN** проверка уже выполняется или пара уже подтверждена
- **THEN** новая попытка не заменяет сохранённую пару, одна проверка активна одновременно, подтверждённые значения не изменяются вызывающим кодом

### Requirement: Candidate verification is real and bounded
Проверка кандидата SHALL использовать только ограниченные операции чтения для подтверждения credentials, фиксированного expected UID и необходимых прав. Она MUST NOT предоставлять order writes, произвольные endpoint-запросы или обходной production accepted. Отсутствующий expected UID и неполная проверка MUST NOT приводить к accepted. Каждая попытка MUST иметь общий deadline, отмену и защиту от запоздалого accepted после отмены.

#### Scenario: Candidate is confirmed
- **WHEN** реальная проверка подтверждает credentials, expected UID и все необходимые права в пределах deadline
- **THEN** авторизация становится успешной независимо от готовности торгового журнала и подключения observers

#### Scenario: Candidate is explicitly unsuitable
- **WHEN** достоверно установлены неверные credentials, несовпадающий UID или неподходящие права
- **THEN** кандидат отклоняется и удаляется, новая попытка разрешена, рабочие подписанные запросы не выполняются

#### Scenario: Verification is inconclusive
- **WHEN** произошли timeout, сетевой или VPN сбой, generic HTTP 403 либо нераспознанный ответ
- **THEN** результат temporary_failure, кандидат сохранён для автоматического retry внутри ABI без нового пароля и не доступен рабочему REST

#### Scenario: Verification finishes after cancellation
- **WHEN** shutdown или deadline отменили попытку, а транспорт позднее вернул успешный ответ
- **THEN** этот результат не приводит к AUTHORIZED или запуску компонентов; таймеры и обработчики отмены освобождены

### Requirement: ABI accepts authorization after startup
ABI SHALL запускаться без credentials в LOCKED, обслуживать HTTP и локальные хранилища без ограничения времени ожидания. Авторизация SHALL выполняться без пересоздания процесса. AUTHORIZED SHALL означать только подтверждение полномочий, а Trading READY SHALL дополнительно требовать существующие проверки торгового состояния.

#### Scenario: Operator authorizes long after deploy
- **WHEN** оператор передаёт пару после произвольного времени в LOCKED
- **THEN** credentials проверяются без перезапуска ABI
- **AND** успешная авторизация не подменяет результат локального восстановления и биржевой проверки привязок

### Requirement: Secret delivery uses local age and Unix socket
age SHALL расшифровывать файл на Mac. Команда SHALL проверять полную пару и успешное завершение age до передачи ограниченного frame через stdin локального docker exec в Unix socket. Socket SHALL иметь права 0600 в каталоге 0700 на tmpfs. Пароль и ключи MUST NOT попадать в argv, env, логи или постоянные открытые файлы. До передачи SHALL проверяться запрет container swap; гарантия отсутствия swap macOS не заявляется. Привилегированный контейнер и Docker socket внутри ABI MUST NOT требоваться.

#### Scenario: Invalid password or incomplete frame
- **WHEN** расшифровка, проверка полной пары, размера или целостности frame неуспешна
- **THEN** authorize не вызывается, кандидат частично не принимается и ABI продолжает работать

### Requirement: Observers and trading readiness have separate lifecycles
Composition root SHALL создавать реальные private WS и REST observers после успешной авторизации однократно. Сетевые сбои SHALL использовать их существующее восстановление соединений. Наблюдательный REST SHALL зависеть только от необходимого успешного локального восстановления, а не от торговой готовности. Исторический backfill и подключение private WS MUST NOT становиться новыми условиями Trading READY.

#### Scenario: Observer reconnects
- **WHEN** после авторизации наблюдательный WS или REST сталкивается с временным сетевым сбоем
- **THEN** принятая пара сохраняется, новый пароль не требуется и повторные observers не создаются

### Requirement: Shutdown prevents late authorization and activation
В начале shutdown ABI MUST запретить новые авторизации и торговые допуски, закрыть канал авторизации и отменить незавершённую проверку/активацию до ожидания завершения HTTP. Запоздавшие результаты MUST NOT разрешать авторизацию или торговлю. Уже допущенные операции SHALL сохранять существующий корректный drain.

#### Scenario: Shutdown races with successful verification or activation
- **WHEN** shutdown начался до завершения асинхронной проверки или активации
- **THEN** её поздний успех не открывает admission, не создаёт новые observers и не переводит систему в READY
- **AND** допущенные ранее команды завершаются по существующим правилам

### Requirement: Execution admission is atomic with a definitive rejection
ABI SHALL принимать одно решение о допуске до биржевых запросов и изменений состояния исполнения. HTTP 503 execution_not_ready SHALL означать отсутствие любых торговых побочных действий этой попытки. Наблюдательная диагностика допускается.

#### Scenario: Readiness changes before admission
- **WHEN** неготовая команда проверяется одновременно с завершением авторизации
- **THEN** она либо отклонена до любых побочных действий, либо допущена один раз
- **AND** отказ не оставляет отложенную команду для будущего исполнения

#### Scenario: Readiness changes after admission
- **WHEN** команда уже допущена и могла начать работу с Bybit
- **THEN** ABI не возвращает execution_not_ready для этой попытки
- **AND** неопределённый результат обрабатывается существующим контрактом исполнения и восстановления

### Requirement: Runtime reuses existing reconciliation without replaying blocked commands
Runtime SHALL отличать execution_not_ready от таймаута и неоднозначного результата. Только при достоверном отказе entry-команды до исполнения Runtime SHALL снять маркер, созданный именно для этой попытки, сохранив состояние до неё. Старые неопределённые операции SHALL продолжать использовать существующий resolver.

#### Scenario: First apply is rejected before execution
- **WHEN** Runtime сохранил pending_entry_recovery и получил достоверный execution_not_ready для этой команды
- **THEN** маркер этой попытки снят и прежнее торговое состояние сохранено
- **AND** unknown_trade_cycle_binding не создаёт зависший recovery для этой попытки

#### Scenario: Timeout or lookup rejection leaves uncertainty intact
- **WHEN** отправка закончилась таймаутом либо recovery lookup вернул execution_not_ready
- **THEN** существующий uncertainty-маркер сохраняется для обычного resolver

#### Scenario: Authorizing does not replay commands
- **WHEN** ABI становится READY после периода блокировки
- **THEN** ни ABI, ни Runtime не воспроизводят отклонённые торговые команды
- **AND** последующие решения используют обычный reconciliation по актуальному состоянию

### Requirement: Deployment is independent from authorization
bbb_stack SHALL обновлять весь стек обычным workflow, сохраняя сервис abi, адрес abi:8787 и существующие данные. Пароль SHALL требоваться только команде авторизации.

#### Scenario: Deploy without any unlocked secret
- **WHEN** оператор выполняет Deploy Demo
- **THEN** весь стек стартует, ABI становится живым в LOCKED, Runtime запускается
- **AND** Mainnet остаётся заблокирован существующим guard

### Requirement: Startup read checks retry autonomously with bounded frequency
После передачи кандидата ABI SHALL автоматически повторять temporary_failure авторизации и unavailable проверки торговых привязок без Mac, Python и повторного ввода пароля. Composition root MUST использовать один retry-таймер с задержками 5, 15, 30 секунд, затем по 30 секунд после завершения предыдущей попытки; смена фазы сбрасывает backoff к 5 секундам. Одновременно MUST NOT выполняться несколько проверок одной фазы, включая гонку с ручным retry. Ручной retry SHALL оставаться диагностическим.

#### Scenario: Network recovers after password entry
- **WHEN** переданный кандидат несколько раз не удалось проверить из-за временной сети, после чего сеть восстановилась
- **THEN** ABI самостоятельно доходит до AUTHORIZED и необходимых торговых проверок с сохранённой парой, без новой доставки credentials

#### Scenario: Trading bindings become available later
- **WHEN** авторизация успешна, но assurance временно не имеет достоверных биржевых данных
- **THEN** ABI повторяет только read-only assurance до успеха с backoff, сохраняя AUTHORIZED
- **AND** local replay, cleanup, observers и торговые POST не запускаются повторно этим таймером

#### Scenario: Definitive rejection does not loop
- **WHEN** кандидат достоверно отклонён, replay неуспешен, policy несовместима или position mode доказанно не совпадает
- **THEN** соответствующая проверка не повторяется автоматически и торговая готовность остаётся закрытой

#### Scenario: Shutdown stops retries
- **WHEN** ABI останавливается с назначенным или выполняющимся автоматическим повтором
- **THEN** таймер снят, verifier отменён, новые попытки не запускаются и поздний результат не разрешает торговлю
