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

- [ ] 4.1 Представить точный diff root, observers и минимального откладывания биржевой проверки; получить отдельное разрешение Apply.
- [ ] 4.2 Подключить настоящий verifier/socket/service и обязательный REST source без env fallback. AUTHORIZED независим от journal; временные сетевые ошибки не удаляют пару.
- [ ] 4.3 Только здесь минимально разделить существующую startup-последовательность: сохранить результат локального восстановления, отложить bindings до авторизации, не повторять replay/cleanup при повторной биржевой проверке. Не менять correlation subsystem и формат данных.
- [ ] 4.4 Однократно создавать реальные WS/REST observers после авторизации. Сохранить их reconnect/worker; backfill не блокирует торговлю, наблюдение зависит только от необходимой локальной готовности.
- [ ] 4.5 Обеспечить shutdown до ожидания HTTP close: запрет нового admission/authorize, закрытие канала, cancellation и защита от поздних результатов; сохранить drain допущенных операций.
- [ ] 4.6 Согласовать admission/routes/guards/health: account зависит от авторизации, торговые циклы дополнительно от существующего recovery/bindings; 503 только до исполнения, без очереди. Убрать credential checks из config; сохранить остальные safety gates.
- [ ] 4.7 Проверить обе последовательности auth/recovery, сломанный journal при AUTHORIZED, повтор активации без дублей, сеть и shutdown; выполнить unit/integration checks и отдельное ревью работоспособного набора. При необходимости разбить интеграцию на согласуемые PR без слияния неработоспособных промежуточных версий.

## Завершение — отдельное разрешение

- [ ] 5.1 Согласовать Runtime #46 и обычный bbb_stack Deploy без пароля, сохранив abi:8787, данные и настройки; отказаться от интерактивного deploy в #103.
- [ ] 5.2 Проверить совместимый набор, documented authorize/retry/status и откат на прежний образ/конфигурацию.
- [ ] 5.3 Только после разрешения выполнить полный Demo smoke и сверку заявок/позиций. Mainnet запрещён.

Шаг 3 реализован в draft [PR #54](https://github.com/roman-vyl/abi_executor_bot/pull/54), коммит 6127546, поверх PR #52. npm test: 1123 pass, 0 fail (включает запуск 7 Python unit tests); typecheck/build успешны. Настоящие Bybit-запросы не выполнялись. Production root, journal, observers, routes, guards и Docker не менялись. Приёмка PR #54 ожидается. Задачи раздела 4 не разрешены к Apply.
