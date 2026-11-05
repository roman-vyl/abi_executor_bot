# Последовательная реализация

Каждый следующий шаг требует отдельного ревью и разрешения Apply. Спек не разрешает реализацию. Отдельного этапа 3A нет; journal/replay до подключения composition root не меняются. Ниже нет задач из PR #51.

## Выполненные компоненты

- [x] 1. Независимый AuthorizationService и изолированные тесты — PR #52, принят пользователем.
- [x] 2. REST CredentialsSource, согласованная пара на запрос, публичный getMarketPrice и тесты — draft PR #53, опубликован для ревью; не сливать до работоспособной интеграции root.

## Следующий шаг — реальный verifier и доставка, без journal

- [x] 3.1 Контракт [verifier-delivery-contract.md](verifier-delivery-contract.md) разрешён к Apply пользователем. Зафиксировать узкий интерфейс verifier, фиксированные read-only endpoints Bybit, проверку expected UID/прав, классификацию ошибок, deadline/cancellation и протокол Unix socket.
- [x] 3.2 После разрешения реализовать ограниченный реальный verifier с подставным транспортом в тестах. Исключить order writes, произвольные endpoints и production fake accepted.
- [x] 3.3 Проверить accepted, неверные credentials/UID/права, отсутствие expected UID, malformed/unknown responses, timeout/VPN/403, retry, зависший Promise, отмену и поздний accepted. Убедиться, что service не зависит от сети, журнала и readiness.
- [x] 3.4 После разрешения адаптировать age и Unix socket: полный ограниченный frame, права/tmpfs, container swap check, stdin, очистка, безопасные ошибки. Тестировать отдельно от production composition root.
- [x] 3.5 Проверить неверный пароль, неполную пару, oversized/оборванный frame, конкурентные попытки, retry и остановку канала. Проверить отсутствие credentials в argv/env/logs/постоянных открытых файлах.
- [x] 3.6 Выполнить npm test, typecheck, build; опубликовать PR и результаты. До отдельной приёмки не подключать production root и не менять journal, routes, guards, observers или Docker deployment.

## Отдельно согласуемая интеграция

- [x] 4.1 Схема [root-integration-review.md](root-integration-review.md) принята к Apply пользователем; интеграция реализована в draft PR #55.
- [x] 4.2 Подключить настоящий verifier/socket/service и обязательный REST source без env fallback. AUTHORIZED независим от journal; временные сетевые ошибки не удаляют пару.
- [x] 4.3 Только здесь минимально разделить существующую startup-последовательность: сохранить результат локального восстановления, отложить bindings до авторизации, не повторять replay/cleanup при повторной биржевой проверке. Не менять correlation subsystem и формат данных.
- [x] 4.4 Однократно создавать реальные WS/REST observers после авторизации. Сохранить их reconnect/worker; backfill не блокирует торговлю, наблюдение зависит только от необходимой локальной готовности.
- [x] 4.5 Обеспечить shutdown до ожидания HTTP close: запрет нового admission/authorize, закрытие канала, cancellation и защита от поздних результатов; сохранить drain допущенных операций.
- [x] 4.6 Согласовать admission/routes/guards/health: account зависит от авторизации, торговые циклы дополнительно от существующего recovery/bindings; 503 только до исполнения, без очереди. Убрать credential checks из config; сохранить остальные safety gates.
- [ ] 4.7 Проверки auth/recovery, сломанного journal при AUTHORIZED, активации без дублей, сети, shutdown и unit/integration выполнены. Осталась внешняя приёмка совместимого набора PR #55/#105/#47. При необходимости разбить интеграцию на согласуемые PR без слияния неработоспособных промежуточных версий.

- [x] 4.8 Дополнение перед merge: один retry-таймер root для temporary_failure авторизации и unavailable assurance, backoff 5/15/30/30…, без Mac/Python/пароля, без POST/replay/дублей observers; тесты частоты, конкуренции, постоянных отказов и shutdown.

## Завершение — отдельное разрешение

- [ ] 5.1 Согласовать Runtime #46 и обычный bbb_stack Deploy без пароля, сохранив abi:8787, данные и настройки; отказаться от интерактивного deploy в #103.
- [ ] 5.2 Проверить совместимый набор, documented authorize/retry/status и откат на прежний образ/конфигурацию.
- [ ] 5.3 Только после разрешения выполнить полный Demo smoke и сверку заявок/позиций. Mainnet запрещён.

Шаг 3 реализован в draft [PR #54](https://github.com/roman-vyl/abi_executor_bot/pull/54), коммит 6127546, поверх PR #52. npm test: 1123 pass, 0 fail (включает запуск 7 Python unit tests); typecheck/build успешны. Настоящие Bybit-запросы не выполнялись. Production root, journal, observers, routes, guards и Docker не менялись. Приёмка PR #54 ожидается. Задачи раздела 4 не разрешены к Apply.

## Результат разрешённой интеграции

- ABI [draft PR #55](https://github.com/roman-vyl/abi_executor_bot/pull/55), 0724fad, поверх #54 и с REST из #53. 1150 npm tests, typecheck, build и OpenAPI validation успешны. src/correlation и lifecycleEvents.ts не менялись; существующая assurance дополнена признаком retryable для unavailable.
- bbb_stack [draft PR #105](https://github.com/roman-vyl/bbb_stack/pull/105), ветка codex/abi-late-authorization-deploy. Обычный workflow сохранён, один прежний abi с прежними данными/адресом; env_file с ключами удалён, health использует liveness, tmpfs и swap limits настроены. Четыре Python checks и Compose config validation прошли. Локальная команда находит контейнер по labels без зависимости от runner env или image manifest. Ранее предложенный интерактивный deploy #103 не используется.
- Runtime [draft PR #47](https://github.com/roman-vyl/strategy_runtime/pull/47), 8593d43, поверх #46: только тесты актуального OpenAPI 503, без production-изменений. 330 contract tests и Ruff check/format успешны.
- Изолированный Compose/production image стартовал healthy в LOCKED при risk sizing. Проверены tmpfs, directory/socket modes 0700/0600, memory.swap.max=0, отсутствие credential env. Тестовый проект удалён.
- Docker + настоящий age на публичной dummy-паре и dummy passphrase: неверный пароль оставляет LOCKED; правильный пароль → stdin/socket → реальный код HMAC/verifier → AUTHORIZED → Trading READY без смены container ID; restart → LOCKED. Подменялся только ответ Bybit через test-only preload, отсутствующий в production image/config. Это не реальная проверка Demo-аккаунта. test/tools/smoke_authorization_docker.py воспроизводит сценарий; контейнер удаляется.
- Действующий Demo и его image pins не менялись, merge/deploy и реальных Bybit-запросов не было. Перед переключением требуются внешняя приёмка, согласованные ABI/Runtime images, trusted Demo UID и сверка необходимых несекретных настроек старого env_file оператором. Задача 5.3 (реальный Demo smoke) не выполнена и без отдельного разрешения не выполняется. Mainnet запрещён.

Дополнение автоматического retry реализовано в PR #55, коммит 0724fad. 1150 npm tests, typecheck, build и OpenAPI прошли. Root tests проверяют 5/15/30/30…, сброс backoff при смене фазы, гонку с ручной проверкой, единственный таймер/observers, отсутствие повторного replay/cleanup и shutdown. Docker + настоящий age на dummy credentials подтвердил: Mac-команда закончилась после первой временной ошибки, затем ABI самостоятельно дошёл до AUTHORIZED/READY без второго ввода пароля; restart вернул LOCKED. Подменён только Bybit transport тестового контейнера; настоящий Demo не менялся. positionModeAssuranceSeams.ts теперь сохраняет retryable=true только для unavailable; journal/replay по-прежнему не менялись.
