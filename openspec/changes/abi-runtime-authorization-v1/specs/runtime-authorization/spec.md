## Purpose

Позволить оператору авторизовать уже работающий ABI в любое время после обычного деплоя BBB, сохраняя существующий reconciliation и безопасный допуск к исполнению.

## ADDED Requirements

### Requirement: Protected ABI accepts authorization after startup
ABI SHALL стартовать без ключей и без таймаута ожидания авторизации. Локальные хранилища и HTTP SHALL оставаться доступными. Авторизация SHALL работать без пересоздания процесса.

#### Scenario: Operator authorizes long after deploy
- **WHEN** оператор передаёт пару после произвольного времени в LOCKED
- **THEN** ABI проверяет ключи и ожидаемый UID, выполняет существующие биржевые проверки активации и становится READY при их успехе
- **AND** исторический REST backfill не является дополнительным условием READY

### Requirement: Local authorization preserves the secret delivery boundary
age SHALL расшифровывать файл на Mac. Команда SHALL проверять полную пару и успешное завершение age до передачи через stdin локального docker exec в Unix socket работающего ABI. Сокет SHALL иметь права 0600 в каталоге 0700 на tmpfs. Ключи и пароль SHALL отсутствовать в аргументах, окружении, логах и постоянных открытых файлах. Подкачка контейнера SHALL быть запрещена и проверена перед передачей.

#### Scenario: Password or payload is invalid
- **WHEN** расшифровка или проверка пары завершается ошибкой
- **THEN** авторизация не начинается и процесс ABI продолжает работать

#### Scenario: Concurrent or repeated authorization
- **WHEN** попытка авторизации уже выполняется либо ABI уже успешно авторизован
- **THEN** другая попытка не заменяет рабочую пару и не запускает дублирующие биржевые компоненты
- **AND** ошибка отклонённой пары допускает новую попытку без рестарта

### Requirement: Temporary connection failures preserve the authorization session
ABI SHALL сохранять принятую пару в памяти при транспортном сбое проверки и допускать повтор проверки без нового пароля. После успешной авторизации временные REST и WS ошибки SHALL использовать существующее поведение повторных подключений и исполнения.

#### Scenario: Bybit is temporarily unreachable
- **WHEN** проверка принятой пары завершилась таймаутом или транспортной ошибкой
- **THEN** торговля остаётся заблокированной, причина доступна оператору и ограниченные по времени проверки повторяются с backoff без запроса пароля

#### Scenario: Credentials or account are explicitly rejected
- **WHEN** Bybit достоверно отклонил credentials или права либо UID не совпал с фиксированным ожидаемым UID
- **THEN** эта пара не активирует торговлю и допускается новая авторизация
- **AND** generic HTTP 403, VPN-сбой или неразобранная ошибка не считаются доказательством неверного ключа

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
