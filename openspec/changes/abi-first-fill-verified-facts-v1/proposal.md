## Why

Подтверждённая через Bybit открытая позиция не сопровождалась Runtime, пока дополнительный REST-поиск точного времени первого исполнения возвращал пустоту. Уже сохранённые execution-факты могут дать это время после неуспешного REST capture, если принадлежность и полнота доказаны.

## What Changes

- Один небольшой компонент проверяет факты SQLite только после того, как существующий REST-поиск first_fill не дал результата; используется open-position и обеими ветками capture в recovery.
- SQLite fallback допускается только для entry-ордера, терминальность и положительный окончательный cumExecQty которого уже доказаны одним согласованным own-order proof. Живой PartiallyFilled остаётся на прежнем REST-пути.
- Проверяет текущую идентичность entry-ордера/цикла/поколения, уникальность execId и точное совпадение суммы Trade execQty с подтверждённым cumExecQty.
- Использует min(execTime); сохранённое first_fill остаётся приоритетным и неизменяемым.
- SQLite недоступен, усечён, неполон или неоднозначен: прежняя безопасная семантика соответствующей ветки после уже выполненного REST.
- Никаких изменений определения open/closed, авторизации, Runtime/Router/Engine, HTTP-контрактов, формата correlation, sizing, close/SL/TP алгоритма или торговых POST. Demo продолжает работать без изменений; Mainnet запрещён. Этот PR содержит только спек, не разрешение Apply/deploy.

## Capabilities

### New Capabilities
- `verified-first-fill-evidence`: единые правила проверки идентичности, полноты и времени execution-фактов.

### Modified Capabilities
- `open-position-resolution`: разрешить проверенные локальные факты как fallback после REST capture после существующего live lookup.
- `entry-cycle-recovery-resolution`: применять тот же порядок источников, сохраняя существующую семантику position_open и terminal_after_fill.

## Impact

ABI: openPositionResolutionService, entryCycleRecoveryResolutionService, небольшой verifier и узкий read-only порт ExchangeFactsStore; минимальная сборка зависимости в composition root. Schema SQLite и correlation JSONL не меняются. Тесты изолированные, без сети и реальных ордеров; npm test/typecheck/build; перед Deploy — измерение sync SQLite и влияния на WS на рабочем объёме данных. Никаких новых сервисов или обязательной зависимости торговли от журнала.
