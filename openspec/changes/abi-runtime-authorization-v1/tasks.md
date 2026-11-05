## 1. ABI lifecycle и авторизация

- [ ] 1.1 Адаптировать PR #49 и protected config для запуска HTTP/локальных хранилищ в LOCKED. Разделить локальный replay и текущие биржевые проверки активации без повторения локальных изменений.
- [ ] 1.2 Добавить сериализованный контроллер авторизации, фиксированный expected UID и позднее подключение REST credentials, private WS и наблюдательного REST reconciler. Сохранить timeout/backoff и ключ при сетевых сбоях, обеспечить однократный запуск и штатное закрытие handles.
- [ ] 1.3 Заменить startup-файлы на Unix socket в tmpfs и команду age → stdin → docker exec → socket. Проверить лимиты кадра, права сокета, swap, очистку буферов и безопасную диагностику.
- [ ] 1.4 Добавить атомарный admission gate и 503 execution_not_ready для exchange-dependent routes, сохранив прежние результаты после допуска. Разделить liveness/readiness и обновить OpenAPI.

## 2. Точечная совместимость Runtime

- [ ] 2.1 Добавить typed execution_not_ready в существующие модели и codecs entry, lookup/recovery и position management. Передать гарантированный entry-отказ через существующий bridge.
- [ ] 2.2 В _execute_one снимать только маркер своей гарантированно отклонённой попытки. Проверить Replace с успешным CANCEL и отказом APPLY. Сохранить существующий resolver и pending для всех неоднозначных ответов.

## 3. Обычный Deploy и операторская авторизация

- [ ] 3.1 Упростить PR #103 до обычного Deploy Demo без интерактивной ветки и пропуска ABI. Использовать liveness healthcheck и restart policy unless-stopped, сохранить адреса, данные и текущие торговые настройки.
- [ ] 3.2 Документировать авторизацию после деплоя, status, повтор проверки без пароля при сетевых сбоях, expected UID и действия после рестарта. Отметить старый startup change как superseded, не синхронизировать его устаревшие требования.

## 4. Проверка

- [ ] 4.1 Добавить ABI тесты поздней авторизации, пары/UID/прав, concurrency, idempotent authorization, временной недоступности и shutdown. Проверить барьерами обе стороны гонки admission и неизменность результата после допуска, отсутствие deferred-команд после разблокировки.
- [ ] 4.2 Добавить Runtime тесты первого APPLY с 503, снятия только своего маркера, Replace, сохранения pending при timeout и lookup 503, продолжения существующего resolver и актуального reconciliation после READY без воспроизведения отказов.
- [ ] 4.3 Выполнить npm test, typecheck, build и fake smoke ABI, соответствующие pytest Runtime и Compose/workflow проверки. На Docker Desktop проверить Deploy без ключа, позднюю разблокировку, рестарт в LOCKED и отсутствие запроса пароля из workflow.
- [ ] 4.4 После отдельного разрешения на интеграционный запуск выполнить Demo read/write smoke и проверку существующего Runtime resolver. Подтвердить сохранение Mainnet guard и очистку только тестовых заявок/позиций.
