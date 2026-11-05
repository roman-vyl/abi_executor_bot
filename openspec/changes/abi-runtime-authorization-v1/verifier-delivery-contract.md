# Пункт 3.1 — контракт verifier и доставки credentials

Статус: пользователь разрешил Apply шага 3. Реализация опубликована в draft PR #54 и ожидает приёмки. Сам verifier не зависит от production composition root и correlation journal; новых подготовительных этапов журнала нет. Последующая разрешённая интеграция реализована в draft PR #55 без изменения correlation subsystem.

## 1. Минимальный интерфейс

Существующий CredentialsVerifier из PR #52 остаётся `(candidate: Credentials) => Promise<VerificationResult>`. Создающая его функция получает immutable policy: environment, expectedUid, category, recvWindow и сигнал остановки. Сетевой транспорт подставляется для тестов; production использует настоящий HTTPS. Эти зависимости не передаются в AuthorizationService.

Policy валидируется до открытия канала авторизации. expectedUid — непустая каноническая десятичная строка положительного UID; category — только поддерживаемые текущим ABI linear или spot. Неподдерживаемая конфигурация не открывает авторизацию, диагностируется без секретов. UID задаётся конфигурацией развёртывания, не приходит в frame и не берётся из самого кандидата.

Результат сервиса остаётся accepted / rejected / temporary_failure. Безопасная причина проверки хранится отдельно как фиксированный код для диагностики, без credentials, сырого ответа, retMsg или сетевого исключения. Это не второе состояние авторизации.

## 2. Один фиксированный запрос

Предлагается один подписанный `GET /v5/user/query-api`, без query, тела и redirect. Документация описывает UID, readOnly и permissions; Demo явно направляет этот запрос на `https://api-demo.bybit.com`. Testnet использует фиксированный домен `https://api-testnet.bybit.com`. Mainnet на текущем этапе не разрешается. Произвольные baseUrl/пути из оператора или frame запрещены.

Источники: [API Key Information](https://bybit-exchange.github.io/docs/v5/user/apikey-info), [Demo API Key Info](https://bybit-exchange.github.io/docs/v5/demo), [Authentication](https://bybit-exchange.github.io/docs/v5/guide#authentication).

Подпись — существующая схема HMAC-SHA256 для GET, пустая query-строка; timestamp и recvWindow в заголовках. Кандидат используется только в этом verifier, не выдаётся рабочему REST. Ни POST, ни создание/отмена ордера, ни запросы журнала, баланса или позиций для проверки не нужны.

Одна попытка — один HTTP-запрос без автоматического retry; общий deadline 10 секунд включает получение и чтение тела. Максимум тела 64 KiB, streaming limit до полного накопления; redirects запрещены. Ошибка TLS, HTTP, чтения или разбора не может дать accepted. Deadline начинает действовать до сетевого вызова, а не только на чтение заголовков.

## 3. Проверка успешного ответа

Требуются HTTP 200, корректный JSON envelope и числовой retCode=0. Затем проверяются типы обязательных полей. Неизвестные дополнительные поля игнорируются; отсутствие или неверный тип обязательных полей означает temporary_failure, а не догадку об авторизации.

- result.apiKey совпадает с ключом кандидата; несовпадение — неконсистентный ответ, temporary_failure.
- result.userID — положительный safe integer; сравнивается его каноническая десятичная запись с expectedUid. Не допускается округление больших чисел, подмена на parentUid или inviterID. Неописанные Int64-поля не используются как fallback; неподдерживаемый формат даёт temporary_failure.
- Несовпадение корректно прочитанного UID — rejected.
- result.readOnly должен быть числом 0. Значение 1 — rejected; другой тип/значение — temporary_failure.
- Для linear требуются permissions.ContractTrade со строками Order и Position; для spot — permissions.Spot со SpotTrade. Это фиксированная политика ABI на основе публикуемых Bybit полей, не доказательство разрешения каждого будущего ордера. DerivativesTrade не считается неявной заменой ContractTrade.
- Обязательная группа должна быть корректным массивом строк. Корректный массив без требуемого права — rejected; отсутствующая группа или повреждённая структура — temporary_failure.

Минимальная политика этого шага проверяет необходимые права; она не вводит новый полный реестр допустимых permission combinations. Отзыв избыточных полномочий ключа остаётся эксплуатационной настройкой. Заявления об отсутствии Withdraw по неполному ответу не делаются.

Документированная структура полей: [API Key Information](https://bybit-exchange.github.io/docs/v5/user/apikey-info). Accepted означает соответствие указанной политике на момент проверки; не гарантирует будущую сетевую доступность или принятие каждого ордера.

## 4. Классификация отказов

Только распознанный валидный Bybit JSON envelope с числовым retCode обрабатывается как биржевая ошибка. Для HTTP 403/429/5xx приоритет имеет временный отказ, даже если присутствует JSON. Для прочих non-200 accepted запрещён; доказательный retCode из списка ниже может отклонить кандидата, остальные случаи временные.

| Результат | Решение |
| --- | --- |
| 10003, 10005, 10007, -2015, 33004 | rejected: явный отказ ключа/прав/аутентификации или истечение срока |
| 10004 | temporary_failure: ошибка подписи может быть дефектом клиента, не доказательством негодной пары |
| 10002, -1 | temporary_failure: время запроса |
| 10010 | temporary_failure: IP не соответствует ограничениям; пароль не исправляет сеть |
| 10000, 10006, 10016, HTTP 403/429/5xx | temporary_failure |
| TLS/DNS/VPN, timeout, redirect, malformed/oversized body, неизвестный retCode | temporary_failure |

Коды сверены с [Bybit Error Codes](https://bybit-exchange.github.io/docs/v5/error). Политика консервативная: нераспознанная причина не удаляет кандидата. Для повторения используется существующий retry(), без повторной расшифровки и без фонового scheduler.

## 5. Deadline и остановка

Каждая попытка получает дочерний AbortController, связанный с общим сигналом закрытия verifier и deadline. Отмена завершает публичный Promise временным отказом и освобождает VERIFYING даже при зависшем транспорте; сетевой запрос одновременно отменяется. Таймеры/listeners снимаются. Транспортный Promise обработан и после отмены, чтобы поздний reject не стал unhandled rejection.

Перед accepted проверяются отмена и deadline; settlement однократный, поздний результат проигрывает отмене. Закрытый verifier не начинает новые запросы, возвращает temporary_failure. При будущей интеграции root синхронно закрывает канал и допуск, отменяет verifier и не допускает позднюю активацию. Текущий шаг не переписывает shutdown root.

## 6. Формат age и socket protocol v1

Зашифрованное содержимое сохраняет формат PR #49: JSON-массив ровно из двух строк `[apiKey, apiSecret]`. На Mac установленный age сам запрашивает пароль. Команда ограниченно буферизует plaintext в памяти, ждёт exit code 0 и проверяет полную пару до передачи. Если age выдал частичный plaintext и завершился с ошибкой, ничего не передаётся.

Предлагаемый путь внутри контейнера `/run/abi-authorization/control.sock`: Unix socket 0600, каталог 0700 в tmpfs, тот же непривилегированный UID ABI. Не открывается TCP/HTTP порт. ABI не получает Docker socket. Перед передачей клиент проверяет memory.swap.max=0; отсутствие подтверждения блокирует передачу. Проверка mount/swap относится к будущему deployment wiring, без изменения Docker в текущем независимом шаге.

Одна socket connection — один UTF-8 JSON frame с завершающим LF и EOF write-side; клиент делает half-close, затем ждёт ответ. Максимум request frame 4096 bytes, максимум строки credentials 1024 ASCII символа; непустые значения допускают A–Z, a–z, 0–9, `_`, `-`, как в прежней доставке HMAC-пары. RSA-ключи этот протокол не поддерживает. UTF-8 декодируется строго; неизвестные поля, дополнительные кадры и хвост после LF отвергаются до authorize(). Сервер ждёт EOF и полную валидацию, поэтому частичный frame не принимается.

```json
{"v":1,"op":"authorize","credentials":["<key>","<secret>"]}
{"v":1,"op":"retry"}
{"v":1,"op":"status"}
```

Для retry/status credentials запрещены. Для authorize обязательна полная пара. Команда на Mac передаёт frame через stdin `docker exec -i` без TTY небольшому клиенту сокета в контейнере. Пароль, plaintext и frame не попадают в argv/env/logs или открытые файлы. Stdin relay не получает собственный способ проверки/сохранения credentials.

Приём frame имеет абсолютный deadline 5 секунд, не продлеваемый каждым chunk. Ровно одна активная control connection, остальные сразу закрываются без чтения credentials с безопасным busy. После полной валидации сервер вызывает соответствующий метод AuthorizationService один раз. Проверка длится максимум 10 секунд; клиент после отправки имеет 15 секунд на ответ. Idle connections не удерживают слот дольше 5 секунд. Shutdown немедленно закрывает listener и connections и отменяет verifier.

Ответ — один JSON+LF, максимум 1024 bytes:

```json
{"v":1,"state":"AUTHORIZED","result":"accepted"}
{"v":1,"state":"RETRY_PENDING","result":"temporary_failure","reason":"verification_timeout"}
```

state — существующий AuthorizationState; result — существующий AuthorizationResult либо protocol_error/shutting_down. reason — только фиксированный безопасный код. status возвращает state без result; credentials, UID из ответа, retMsg, подписи и исключения не возвращаются. Ответ accepted не сообщает Trading READY и не запускает торговые компоненты.

Разрыв клиента до полной валидации не вызывает authorize. После начала authorize разрыв не откатывает попытку: она завершится по своему deadline; результат узнаётся новым status. Потерянный ответ не считается отказом и не вызывает автоматическую повторную отправку пары. Повторный authorize не заменяет принятую пару согласно PR #52.

Буферы plaintext/frame очищаются в finally при всех исходах; копии строк JS и память дочерних процессов не считаются гарантированно уничтоженными. Зашифрованный файл хранится на диске, пароль не сохраняется. Контроль прав сокета не защищает от Docker daemon или компрометации самого ABI.

## 7. Проверки для будущего Apply

- Фиксированный URL/method, отсутствие тела и redirect; корректный HMAC без рабочего adapter; никакого order-write транспорта.
- Успех linear/spot, UID mismatch, safe-integer boundary, readOnly, отсутствие и типы прав, malformed/oversized response; все строки таблицы отказов.
- Зависший транспорт/body, deadline, остановка перед/во время/после ответа, поздний accepted/reject, освобождение VERIFYING и listeners, явный retry.
- Неверный пароль/частичный вывод age; split chunks, invalid UTF-8, лишние поля/строки, oversized frame, обрыв до LF/EOF, slow sender, busy.
- authorize/retry/status, потерянный ответ после начала проверки, отсутствие повторной отправки и подмены пары, shutdown listener/connections.
- Отсутствие ключей в логах/ответах/argv/env/файлах, cleanup plaintext и frame во всех исключениях, права socket и каталога.
- Тесты с подставным транспортом и временным локальным socket. Без реальных ключей, Bybit-запросов, изменений production root, журнала, observers, маршрутов или deploy.

Пункты 3.1–3.6 выполнены по отдельному разрешению Apply. Результаты и PR #54 указаны в tasks.md. Production-интеграция требует следующего отдельного ревью и Apply.
