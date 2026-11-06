# Реализация и проверка first-fill fallback

Рабочий Demo не изменялся. Mainnet не включался. Merge/deploy не выполнялись. Реализация требует отдельного ревью; результаты измерений не являются разрешением Deploy.

## Функциональная проверка

Один captureFirstFill сохраняет REST-first: saved timestamp → существующий REST capture → optional локальный verifier после неуспеха. В open-position proof передаётся из того же own-order observation, которым установлено состояние; recovery передаёт тот же proof через существующие binding-continuity guards под pair mutex. Terminal-after-fill остаётся best-effort. Положительная финальная quantity и terminality не берутся из SQLite, create ACK или aggregate position.

Покрыто: single fill, несколько уникальных partial executions терминального ордера, cancelled remainder, exact decimal sum, совпадающие WS/REST дубли, конфликт execId/time/qty, пропуски/overcount, идентичность/поколение/роль/сторона/slot, повреждённые данные, выключенный/ошибающийся store и достигнутый лимит. При live partial и при успешном REST дополнительных SQLite reads нет. Проверены оба сервиса, terminal-after-fill capture, закрытый цикл, state veto, missing confirmed orderId, saved timestamp и first-fill-only write failure. Общий regression suite сохраняет closure/generation/convergence проверки.

Проверки: npm test — 1208/1208 passed, typecheck, build, OpenAPI (5 документов / 11 операций), strict OpenSpec validate, git diff --check. Первый sandbox-run полного набора не мог открыть fake localhost servers (EPERM); повтор выполнен с разрешённым localhost и без реальной биржи.

## Изолированное измерение на Mac / Docker Desktop

- Согласованный consistent backup-снимок до переключения, 1 417 216 байт; рабочая база по размеру на момент подготовки также около 1.4 MB. Открывался только отдельный файл-копия внутри тестового контейнера; credentials и рабочие каталоги ABI не монтировались.
- arm64, production runtime image ABI c21ca11, Node 20.20.2; подмонтированы собранные dist проверяемого изменения. 1 GiB memory/memswap, readonly rootfs, network=none, без capabilities, пользователь 501:20 (владелец тестовых bind-файлов). Production UID отличается; это ограничение сравнения, не полномасштабный production benchmark.
- Те же store pragmas: WAL, locking_mode=EXCLUSIVE, synchronous=FULL, busy_timeout=5000. Индексированный readFactsForOrder + readLinkForOrder через тот же открытый store.
- Четыре фазы по 20 секунд. 20 capture запросов/с, 20 WS frames/с × 5 executions = 100 executions/с. Настоящий ExchangeStreamRecorder и writeStreamBatch, flush interval 1000 ms; WS server локальный синтетический, часы performance.now() в одном процессе. Нет WAN/Bybit/торговых команд.
- Перед каждой фазой новая копия одного snapshot, затем одинаковый recorder workload. Целевой entry имеет 2, 999 либо 1000 execution-строк; read limit=1000. Все fallback requests намеренно повторяют capture без сохранения результата: это нагрузка на часто вызываемый fallback, не частота нормальной торговли после capture-once.
- 396 периодических запросов + один первый запрос/фаза; 397 samples каждого SELECT в fallback. 1980–1985 WS execution events/фаза. Выросшие копии после checkpoint: 2.54–3.30 MB.

Полные p50/p95/p99/max, sample counts и результаты: `test/reports/first-fill-latency-20261106.json`.

Все значения таблицы в миллисекундах:

| Фаза | facts SELECT p99 / max | link SELECT max | capture p99 / max | event-loop p99 / max | WS receive p99 / max |
| --- | ---: | ---: | ---: | ---: | ---: |
| REST success | нет чтений | нет чтений | 0.225 / 0.597 | 2.345 / 15.409 | 1.540 / 2.091 |
| fallback, 2 факта | 0.296 / 0.506 | 0.358 | 0.919 / 1.032 | 2.271 / 13.206 | 1.440 / 1.823 |
| fallback, 999 фактов | 9.278 / 9.406 | 1.363 | 13.241 / 14.774 | 11.600 / 16.450 | 12.104 / 13.241 |
| fallback, 1000 фактов — отказ по лимиту | 9.197 / 10.104 | 1.086 | 9.586 / 10.434 | 8.929 / 13.582 | 8.629 / 10.024 |

`capture` включает немедленный fake REST и является консервативной верхней оценкой затрат полного verifier в этом стенде, не измерением живого HTTP lookup. Отдельно измерены link/facts SELECT. Ошибок ожидаемого результата нет; на лимите ожидается отказ, а не успешное доказательство. Потерь WS и остаточного backlog нет. WS flush p99 ≈ 992.375–1000.472 ms, max ≈ 999.621–1006.003 ms при flush interval 1000 ms. Batch write max ≈ 11.292–13.406 ms.

Первый capture после открытия store: rest_success: 0.233 ms; fallback_small: 0.385 ms; fallback_near_limit: 4.352 ms; fallback_at_limit: 1.911 ms. Это connection-cold, не физически холодный диск: кеши macOS/VM не сбрасывались. Из двух коротких последовательных прогонов нельзя вывести worst-case bound, причинность каждого максимума или безопасность при деградации общего диска. Try/catch и LIMIT не прерывают синхронный I/O stall. Нулевой риск event-loop blocking не заявляется.

Измеренное следствие: малый fallback дешёв, у read limit заметно растут p99 event-loop и WS latency. Допустимость этой регрессии должна быть отдельно принята перед Deploy. Никаких автоматических новых очередей/workers или повышения лимита не предлагается.

## Воспроизведение

Нужен отдельно согласованный consistent snapshot/экспорт владельцем, не файл работающей SQLite с неучтённым WAL. Ниже только изолированный стенд. В копиях могут оставаться чувствительные account facts — не коммитить и не публиковать базы; публикуется только обезличенный metrics.json.

```sh
ABI_CHECKOUT=/path/to/review-checkout
SNAPSHOT=/path/to/approved-consistent-snapshot.sqlite3
BENCH_ROOT=/path/on/mac/docker-bind-storage/first-fill-benchmark
mkdir -m 700 "$BENCH_ROOT"
mkdir -m 700 "$BENCH_ROOT/results"
cp "$SNAPSHOT" "$BENCH_ROOT/snapshot.sqlite3"
chmod 600 "$BENCH_ROOT/snapshot.sqlite3"
cd "$ABI_CHECKOUT"
npm run build
docker run --rm --network none --read-only \
  --user "$(id -u):$(id -g)" --cap-drop ALL \
  --security-opt no-new-privileges --memory 1g --memory-swap 1g \
  --pids-limit 128 --tmpfs /tmp:rw,nosuid,noexec,size=64m \
  -v "$BENCH_ROOT:/work:rw" \
  -v "$ABI_CHECKOUT/dist:/app/dist:ro" \
  -v "$ABI_CHECKOUT/test/tools/benchmark_first_fill.mjs:/app/test/tools/benchmark_first_fill.mjs:ro" \
  ghcr.io/roman-vyl/abi_executor_bot:c21ca11d9795099a4a1d2d3e261da181c98cbb75 \
  node /app/test/tools/benchmark_first_fill.mjs /work/snapshot.sqlite3 /work/results 20
```

Опциональный последний аргумент выбирает одну из четырёх фаз для отдельного процесса. Это позволяет повторять connection-cold samples без уничтожения host/VM cache и без воздействия на Demo.
