# Независимый verifier и доставка credentials

Эта версия подключает авторизацию к существующему startServer. После обычного запуска ABI находится в LOCKED; age/socket авторизация выполняется без рестарта. Деплой действующего Demo требует отдельного разрешения и согласованных ABI/Runtime image pins. Mainnet запрещён.

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

## Интеграция и проверки

Укажите ABI_EXPECTED_BYBIT_UID доверенного целевого Demo-аккаунта и tmpfs /run/abi-authorization (uid/gid 1000, mode 0700). HTTP /health/live доступен в LOCKED; /health/ready и /health показывают Trading READY. Состояния authorization, localRecoveryReady и bindingsVerified сообщаются отдельно. BYBIT_API_KEY/BYBIT_API_SECRET больше не читаются config, даже при risk sizing. Env-fallback отсутствует.

Root использует прежний replayCorrelationStore() без изменения lifecycleEvents.ts. Его локальный результат сохраняется, после авторизации выполняется прежняя assurance. Retry не повторяет replay/cleanup. AUTHORIZED не зависит от journal; account API сохраняет доступ при ошибке торгового восстановления. Observers создаются однократно после авторизации и не определяют торговую готовность. 503 execution_not_ready выдаётся до use case; после допуска сохраняется прежний результат.

Перед server.close() shutdown блокирует admission и socket, отменяет verifier и запрещает поздний READY. REST pool и хранилища сохраняются до drain допущенных HTTP-команд.

Воспроизводимый изолированный smoke (Docker и age в PATH):

```sh
docker build -t abi:authorization-root-review .
python3 -B test/tools/smoke_authorization_docker.py
```

Smoke использует только публичные dummy credentials и dummy passphrase. Test-only preload подменяет транспорт Bybit и проверяет реальный HMAC; он не входит в production image или Compose. Проверяются неверный пароль, LOCKED → AUTHORIZED → READY в одном контейнере, restart → LOCKED. Это не реальный Demo smoke. Production путь не содержит тестового accepted, host override или test transport env-настройки.
