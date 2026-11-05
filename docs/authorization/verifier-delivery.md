# Независимый verifier и доставка credentials

Эта реализация ещё **не подключена к production startServer**. Команда ниже заработает для действующего ABI только после отдельно принятой интеграции composition root и Docker-конфигурации. Текущий PR не запускает и не обновляет Demo.

`createAuthorizationSocket({ path, policy })` создаёт один AuthorizationService с настоящим Bybit verifier. Возвращённый `authorization` — тот же единственный владелец credentials для будущего подключения REST; `close()` немедленно прекращает приём, отменяет проверку и закрывает соединения. Factory не знает о journal, readiness или trading-компонентах.

Policy содержит environment (demo/testnet), expectedUid (строка UID целевого аккаунта), category (linear/spot), recvWindow. UID и права проверяются одним подписанным GET /v5/user/query-api. Verifier не имеет произвольных URL/методов или order writes. Общий deadline 10 s, response limit 64 KiB; временная ошибка сохраняет кандидата для явного retry. Файлы tests используют подставной транспорт с реальным кодом подписи/проверки, production fake accepted отсутствует.

Socket frame: JSON+LF и EOF write-side; максимум 4096 bytes, 5 s на приём. Команды authorize (полная credentials-пара), retry, status. Одна активная control connection. Ответ accepted сообщает только AUTHORIZED, не Trading READY. При потерянном ответе сначала status, автоматического resubmit нет. Закрытие после начала authorize не отменяет его результат.

Файл .age содержит JSON `[apiKey, apiSecret]`. Для будущего штатного контейнера:

```sh
python3 scripts/abi-authorize.py CONTAINER authorize /path/to/credentials.age
python3 scripts/abi-authorize.py CONTAINER retry
python3 scripts/abi-authorize.py CONTAINER status
```

Нужны установленный age, Python 3 и Docker CLI на Mac. age запрашивает пароль самостоятельно. Команда сначала проверяет tmpfs `/run/abi-authorization` и `memory.swap.max=0`, затем расшифровывает полный payload в ограниченный буфер. Только exit code 0 и валидная пара допускают stdin-доставку. Relay `/app/dist/authorization/credentialRelay.js` дополнительно проверяет tmpfs/swap и отправляет frame в `/run/abi-authorization/control.sock`. Клиент не принимает пароль или ключи через argv/env, не пишет plaintext-файлы и печатает только фиксированные поля ответа.

Factory проверяет владельца и mode 0700 каталога, устанавливает socket 0600 и не заменяет существующий путь. Сам mount будет обеспечен будущей Docker-конфигурацией; в текущем изолированном PR Docker не меняется. Локальные socket tests используют временный каталог, без обещания tmpfs на Mac. Проверку swap/тип mount выполняют production CLI и relay до отправки.

Политика отказывает при явных ошибках ключа/прав и несовпадении UID. Сеть, HTTP 403/429/5xx, ошибки подписи/времени/IP, неизвестные/повреждённые ответы означают temporary_failure. Авторизация не проверяет состояние торговых привязок и не заменяет safety checks исполнения.

Открытые byte buffers очищаются best effort в finally; строки JS/Python, библиотеки и память ОС могут сохранять копии. Отсутствие swap на macOS не гарантируется. Компрометация ABI или Docker daemon остаётся за принятой границей защиты.

Проверки: npm test (включает Python unit tests команды), npm run typecheck, npm run build. Только подставные credentials и транспорт, Unix socket и localhost HTTP существующих тестов. Никаких запросов реального Bybit и изменения журнала.
