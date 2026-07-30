# Entry-Package Execution & Correlation Foundation — Exploration Audit

> Exploration report for Stage A (production entry-package execution and correlation
> foundation). Produced via `/opsx:explore`. This is a thinking/audit artifact, not an
> OpenSpec change — no production code, tests, or public contract were modified while
> producing it.

> **Review update (pass 1).** This revision incorporates accepted architectural decisions
> from a review pass over the original exploration (position-sizing boundary, Bybit
> push/pull model, async application contours, the fill-before-acknowledgement race,
> Stage B delivery ordering, and an expanded confirmation state machine). Sections marked
> **UPDATED** revise an earlier conclusion; sections 22–27 are new.

> **Correction pass 2.** A narrow correction pass verified trigger-direction semantics
> against `roman-vyl/strategy_engine` and `roman-vyl/strategy_runtime`, official Bybit V5
> API docs (checked 2026-07-30), and closed the position-sizing rules source, correlation
> durability boundary, and repeat-PUT truthfulness questions. It found a genuine
> counter-example in the only implemented strategy (`ema_pullback`) and, at that point,
> escalated trigger direction into a cross-repo contract blocker.

> **Correction pass 3.** That escalation is itself reversed here: the cross-repo
> contract-gap conclusion was an over-generalization of a Bybit-specific execution detail
> into the Engine/Runtime contract. Trigger direction is now closed as a deterministic,
> ABI-owned V1 mapping (`long → Buy+falls_to`, `short → Sell+rises_to`, via a new
> `EntryOrderSemanticsMapper`) for the currently supported EMA-pullback geometry, with an
> explicit non-blocking future-compatibility note if the Engine ever ships a different
> geometry. Market-price derivation remains independently **rejected** — but no longer as
> evidence of an incomplete public DTO. No public Engine → Runtime → ABI contract change
> is required.

> **Correction pass 4.** A narrow follow-up fix pass: (1) narrowed the durable
> "first-fill/cumulative execution facts" concept (§8/§17/§24/§26) to an aggregate
> `early_execution_observation` snapshot (order_status, cumulative_filled_qty,
> remaining_qty, avg_execution_price?, observed_at) — individual fills, first-fill
> determination, and execution-history recovery are now explicitly Stage B concerns, not
> Stage A; (2) explicitly prohibited any price-admission gate before CREATE (§5 /
> acceptance matrix) — Stage A never compares current market price to
> `planned_entry_price` to decide direction or to accept/reject sending the order; Bybit
> alone decides acceptance, immediate execution, or rejection; (3) split out Runtime
> `ticker` → Bybit `symbol` resolution (§6/§17/§28i) as a separate ABI-wide instrument
> identity concern — a real, non-cross-repo dependency that Stage A explicitly does not
> design, only consumes. Neither of the two judgment calls this pass required (Stage A
> readiness impact of the narrower durability model; blocking status of the ticker→symbol
> dependency) changed the final status.

> **Correction pass 5.** Pass 4's `READY FOR /opsx:propose` status was **premature**: two
> content-level decisions inside sections it touched (§6, §12) were left implicit/
> unaddressed rather than actually resolved. Fixed here: (1) §6 — `FixedMinimumPosition-
> SizeCalculator`'s "minimum executable quantity" claim only checked `min_order_qty`/
> `qty_step`, silently ignoring Bybit's `min_notional_value`, which could make the claim
> false (an order clearing qty checks can still be rejected for insufficient notional).
> Fixed by adding `min_notional_value` to `InstrumentTradingRules` and an explicit
> `max(qty_by_min, qty_by_notional)` formula — the name and claim are now both accurate,
> no rename needed. (2) §12 — the "terminal without fill" branch previously specified
> silent **auto-recreate** (new generation, new create, `entry_package_applied` for the
> new order), a disputed business-semantics decision that was never actually agreed, only
> asserted. **Decision B adopted**: preserve terminal state, fail closed
> (`internal_error`, new `terminal_unfilled` status in §8), no automatic resurrection in
> the same trade cycle; unblocking requires an explicit `CANCEL` (desired_entry=null)
> first. See **"Audit disposition"** at the end of this file for the full conclusion
> ledger and final status: **READY FOR `/opsx:propose`**. Nothing here has been
> implemented — this remains an exploration/audit artifact, still pre-`/opsx:propose`.

```
HEAD:              1fe1f51124ea4c8d9a88f455fe07d9ff822f8929
branch:            main
working tree:      clean
canonical capability: openspec/specs/abi-entry-package-api/spec.md
archived change:      openspec/changes/archive/2026-07-25-abi-entry-package-api-v1/
```

## 1. Baseline & authoritative sources

Подтверждено ровно так, как описано в задании. `entryPackageRoutes.ts:66-84` полностью
валидирует path, content-type, JSON-тело и закрытый `EntryPackageCommand` DTO — а затем
сознательно отбрасывает провалидированную команду (`void validation.command`) и
возвращает `internalErrorResult()`. Комментарий в коде прямо это подтверждает:
*"Execution wiring is deliberately outside abi-entry-package-api-v1."* Route matching,
DTO validation, exact-decimal parsing, success-сериализаторы (`entryPackageApi.ts:169-214`
— написаны, но route их **ещё не вызывает**) и OpenAPI
(`docs/openapi/abi-entry-package-api-v1.json`) — всё реализовано и покрыто тестами.

Один конфликт авторитетности сразу нашёлся: архивный design.md для
`abi-entry-package-api-v1` всё ещё показывает `accepted_risk_multiplier` в success-примере,
но коммит `1fe1f51` убрал его из реального ответа и канонического spec.md. **design.md
устарел; код и канонический spec — верны.** Полезный прецедент для §15: проект уже
двигался в сторону сокращения публичной поверхности, а не расширения.

## 2. Текущий entry-package HTTP boundary

Реализовано полностью, как в задании. Важная деталь: `serializeAppliedEntryPackage` /
`serializeAbsentEntryPackage` уже существуют и протестированы изолированно, но route их
не вызывает — это готовый, но неподключённый выходной слой application-layer, ждущий
сервис.

## 3. Legacy execution contour (signal/intent flow)

```
POST /signals (createSignalIntent.ts)
  parseSignalIntent → checkSignalRisk → dedup (hasSignal / findActiveIntentByInstanceId)
  → calculatePositionSize → buildExecutionPlan → mapExecutionPlanToBybit
  → capturePreCreateProtectionSnapshot (position query, pre-create baseline)
  → executeEntryOrder (liveGuard-gated Bybit create)
  → verifyPostCreateProtection (bounded 2×300ms retry: getOrderByLinkId + getPosition,
     затем market-price stop-breach check, затем emergency market close при breach)
  → journal.appendEvent(...) на каждом шаге (JSONL, ключ — signalId)

PUT /intents/:signalId (updateIntent.ts)  → пересчёт плана → amendEntryOrder → journal
POST /intents/:signalId/cancel (cancelIntent.ts) → последний план из journal → cancelEntryOrder → journal
GET  /intents/:signalId, /intents/:signalId/orders/entry (queryIntent.ts) → journal read, Bybit getOrderByLinkId
```

| Операция | Файл | DTO | Что доказывает ack | Чего не доказывает | Reuse для entry-package |
|---|---|---|---|---|---|
| create | `execution.ts:executeEntryOrder` | `BybitCreateOrderPayload` | Bybit принял create | что ордер живой, поля совпадают, protection прикреплена | **Да**, как есть |
| amend | `execution.ts:amendEntryOrder` | `BybitAmendOrderPayload` | Bybit принял amend | какие поля реально изменились на бирже | **Да**, как есть |
| cancel | `execution.ts:cancelEntryOrder` | `BybitCancelOrderPayload` | Bybit принял cancel | что ордер был в отменяемом состоянии | **Да**, как есть |
| query | `bybitAdapter.ts:getOrderByLinkId` | `BybitGetOrderByLinkIdPayload` | текущая запись биржи по link id | ничего сверх этого | **Да**, как есть |
| confirm | `verifyPostCreateProtection.ts` | position/order snapshots | order-found-or-position-open в bounded retries | точное совпадение цены/qty/stop/take | **Частично** — механика переиспользуема, field-diffing нужно писать заново (§10) |

Ни одна из этих пяти функций не завязана на signal/instance на уровне типов —
принимают только `config`/`bybit`/`payload`. Связанность живёт на уровень выше — в
orchestration-функциях и в **`buildOrderLinkId`**.

## 4. Reusable vs non-reusable

**Переиспользуемо как есть (exchange-mechanics слой):** `bybitAdapter.ts`,
`bybitOrderMapper.ts`, `execution.ts`, `liveGuard.ts`. Ни один не знает, что такое
"signal" или "instance".

**Переиспользуемо с адаптацией:** `protectionDecision.ts` / `verifyPostCreateProtection.ts`
— bounded-retry паттерн запроса верный, но `ProtectionCheckContext.signalId/instanceId` —
просто непрозрачные метки для журналирования; их можно заменить на
`strategy_instance_id`/`trade_cycle_id` без изменения логики решения. Не хватает
field-level верификации (§10).

**Не переиспользуемо — и в одном случае переиспользовать нельзя:**
- `orderIdentity.ts:buildOrderLinkId(instanceId, "entry")` — ключ только instance,
  доказуемо сломан для повторных циклов (§7).
- `journal.ts:findActiveIntentByInstanceId` — зашивает legacy-правило "один активный
  planned intent на instance", придуманное самим ABI. Перенос в entry-package незаметно
  добавил бы ABI-семантику, которую канонический spec прямо запрещает ("ABI SHALL impose
  no ... derivation rule on these Runtime-owned values").
- `riskGuard.ts:checkSignalRisk` — навязывает порядок stop/take цен. Канонический spec
  **явно запрещает** это: *"ABI SHALL NOT add ... a price-order rule ... for
  planned_entry_price or initial_stop_price."* Переиспользование нарушило бы уже
  опубликованный контракт. Это negative-reuse находка, не просто неприменимость.
- `positionSizing.ts:calculatePositionSize` — буквально `void intent;`, возвращает
  фиксированный qty из конфига. Risk-sizing логики нет нигде (§6).
- `domain/signals.ts:parseSignalIntent` — полностью заменена собственной (более строгой,
  exact-decimal) валидацией в `entryPackageApi.ts`.
- Тела `createSignalIntent.ts`/`updateIntent.ts`/`cancelIntent.ts` — *форма*
  (validate→plan→pre-snapshot→guarded-execute→verify→journal→respond) хороший шаблон для
  подражания, но сам код жёстко привязан к signal-ключевым journal lookup'ам и guard'у
  duplicate-signal/active-intent, неприменимому к идемпотентному PUT желаемого состояния.

`trade_cycle_id` как концепция **не существует нигде** в кодовой базе за пределами
entry-package файлов — подтверждено grep'ом. Это действительно новая территория для ABI,
а не переименование существующего.

## 5. APPLY / REPLACE / CANCEL семантика

```
                    ┌─────────────┐
   нет записи       │             │  desired_entry присутствует
   + desired_entry ─┤   CREATE    ├─→ applied
                    │             │
                    └─────────────┘

   есть запись        ┌─────────────┐  те же поля (amend-safe)
   + entry изменён ───┤   REPLACE   ├─→ amend-in-place → applied
                      │             │  side/direction изменились
                      └─────────────┘─→ cancel-and-create → applied

   есть запись        ┌─────────────┐
   + desired=null ────┤   CANCEL    ├─→ absent
                      └─────────────┘

   нет записи         ┌─────────────┐
   + desired=null ────┤  CONFIRM    ├─→ absent (вероятно без вызова биржи)
                      └─────────────┘
```

### Trigger direction — resolved as ABI-owned V1 execution mapping (UPDATED — correction pass 3, REVERSES the "BLOCKER" conclusion)

> **Correction pass 3.** Пройденный ранее вывод ("`DesiredEntry` contract неполон, нужен
> cross-repo `trigger_direction`") был **чрезмерным обобщением** Bybit-specific execution
> semantics в вышестоящий Engine/Runtime contract. Он отменяется. Market-price-derivation
> остаётся отдельно и независимо **REJECTED** (см. ниже) — но отсутствие
> market-price-derivation больше **не доказывает** неполноту public DTO, потому что
> направление можно зафиксировать детерминированно и локально в ABI, без сравнения с
> ценой и без нового поля в контракте.

`DesiredEntry` в DTO содержит `planned_entry_price` и `side`, но **не содержит**
Bybit-specific `trigger_direction`. Это больше не рассматривается как пробел контракта —
Runtime/Engine намеренно не должны знать о Bybit `triggerDirection = 1 | 2`, Bybit order
payload или Bybit-specific conditional-order представлении; это Bybit execution detail,
которым владеет ABI, как ABI уже владеет маппингом `side → Buy/Sell`.

**Факты из исследования `roman-vyl/strategy_engine`
(`/Users/mcroma/BBB_project/strategy_engine`) — сохранены как доказательство принятого
V1 mapping, не как доказательство contract gap.** Единственная реализованная стратегия —
`ema_pullback`. Триггер-логика —
`src/strategy_engine/strategies/ema_pullback/triggers.py:144-173` (`_touch_anchor`) и
`:94-141` (`_rolling_reclaim`):

- **Long**: `touch = low <= anchor` (цена опустилась через anchor), `close_ok =
  close >= anchor` (бар закрылся обратно выше). Trigger = `touch AND close_ok`.
- **Short**: зеркально — `touch = high >= anchor`, `close_ok = close <= anchor`.

Entry price = anchor на баре триггера (`potential_entries.py:96-102`). Из семантики
`close_ok` следует: в момент генерации `DesiredEntry` цена **уже** на trend-стороне
anchor:

```
side = long  → close >= anchor = planned_entry_price
             → цена уже ВЫШЕ уровня → pending entry исполняется при возврате вниз → falls_to

side = short → close <= anchor = planned_entry_price
             → цена уже НИЖЕ уровня → pending entry исполняется при возврате вверх → rises_to
```

Единственная реализованная стратегия (`docs/14_ema_pullback_triggers_v1.md`,
`docs/15_ema_pullback_risk_entries_v1.md` — "EMA Pullback"; breakout-паттерна в
репозитории не существует — `grep -rniE "breakout"` по `docs/*.md` не даёт совпадений)
даёт стабильную, детерминированную геометрию: `long → falls_to`, `short → rises_to`.
Backtest/replay не выводит направление отдельно — переиспользует те же side-branching
trigger-функции, направление никогда не материализуется как отдельное поле — что
согласуется с тем, что это выводимая, а не транспортируемая величина.

**Принятое V1-решение — три уровня владения семантикой:**

```
Engine / Runtime
→ владеют generic торговым намерением: DesiredEntry.side = long | short,
  planned_entry_price, initial_stop_price, initial_take_price, ...
→ НЕ знают Bybit triggerDirection, Bybit order payload,
  Bybit-specific conditional-order representation

ABI application/domain layer
→ владеет поддерживаемой V1 execution mechanic:
  long  → Buy + falls_to
  short → Sell + rises_to

Bybit adapter
→ владеет последним техническим кодированием:
  rises_to → 1
  falls_to → 2
```

Это прямое продолжение уже принятого в этом audit принципа (§4: "ABI SHALL impose no ...
derivation rule on these Runtime-owned values" применяется к транспортным полям, но
семантика Bybit execution всегда была and remains ABI's own concern — так же, как ABI уже
детерминированно мапит `long/short → Buy/Sell` без запроса у Runtime).

**Ownership конкретизирован через новый компонент, `EntryOrderSemanticsMapper`** — см.
§16. Не преобразовывать `long/short` прямо в числовое Bybit-поле внутри HTTP route или
top-level application service.

**V1 scope limitation — честно зафиксировано:** это НЕ универсальный закон "long всегда
означает falls_to для любой стратегии". Это специфичный, версионированный mapping для
**текущей поддерживаемой EMA-pullback entry geometry**. Generic поддержка breakout-long
(`rises_to`) / breakdown-short (`falls_to`) или произвольной strategy-defined entry
geometry **не входит в Stage A** (§17 non-scope).

**Future compatibility gate (deferred, non-blocking, не проектируется превентивно):**
если Strategy Engine в будущем начнёт публиковать стратегию с другой entry geometry, где
`side` недостаточно для выбора поддерживаемой биржевой механики, потребуется отдельное
расширение generic Engine → Runtime → ABI entry contract либо отдельный
execution-profile discriminator. Это не блокирует Stage A, не входит в
`abi-entry-package-execution-v1`, не требует изменений Engine/Runtime сейчас и не
становится сейчас optional-полем или speculative enum.

**Факты из исследования `roman-vyl/strategy_runtime`
(`/Users/mcroma/BBB_project/strategy_runtime`) — сохранены как контекст, не как
обоснование блокера.** Runtime — доказанно чистый pass-through: декодирует `DesiredEntry`
из wire-ответа Strategy Engine и ретранслирует ABI без интерпретации
(`wire_codec.py:156-171` → `entry_reconciliation_bridge/bridge.py:80-101` →
`abi/entry_package_codec.py:78-142`), не содержит concept
`trigger_direction`/`rises_to`/`falls_to`/`breakout`/`pullback` нигде и не проверяет
соотношение `side` и `planned_entry_price`. Это подтверждает, что Runtime корректно не
несёт Bybit-specific знания — ровно то распределение ответственности, которое принято
выше, а не свидетельство необходимости расширять его контракт.

**REPLACE — amend vs cancel-and-create:** не изменилось. `BybitAmendOrderPayload`
подтверждён официальной документацией (§7): amendable — `triggerPrice`, `qty`,
`stopLoss`, `takeProfit`, trigger-by источники; `side`, `orderType`, `triggerDirection` —
не amendable. Рекомендация: amend-in-place для изменений trigger price / qty / stop /
take; fail-closed на cancel-and-create при смене `side` (что теперь детерминированно
меняет и mapped `triggerDirection` через `EntryOrderSemanticsMapper`); смену `ticker`
внутри одного `trade_cycle_id` — contract misuse, fail-closed.

**Никакого price admission gate перед CREATE (correction pass 4).** Stage A **не
сравнивает** current market price с `planned_entry_price` перед отправкой create-заявки
— ни как условие допуска, ни как способ выбора direction (последнее уже отдельно
запрещено выше через `EntryOrderSemanticsMapper`). ABI отправляет детерминированную
команду:

```
long  → Buy + falls_to
short → Sell + rises_to
```

Принятие, немедленное исполнение (если trigger price уже "по ту сторону" текущей цены на
момент отправки) или отклонение заявки — решение Bybit, не ABI. Текущая рыночная цена **не
меняет direction** (закрыто выше) **и не запрещает отправку заявки** — ABI не вводит
собственный pre-flight price-sanity guard, которого не требует ни канонический spec, ни
Bybit API. Это устраняет дополнительный источник недетерминизма: одинаковый `DesiredEntry`
всегда порождает одинаковую попытку create, независимо от того, в какой момент времени
(и по какой текущей цене) она отправляется.

## 6. Quantity/sizing prerequisite — прямые ответы (UPDATED by review)

> **Review update.** Предыдущий вывод *"ABI может игнорировать `risk_multiplier` в ready
> production mode"* — **REJECTED**. См. пересмотренные выводы ниже.

Принятое архитектурное решение: Stage A не реализует настоящий risk-based sizing, но
application workflow не должен напрямую использовать захардкоженный quantity. Вводится
стабильный internal application/domain boundary:

```
PositionSizeCalculator (port)

calculate(
    ticker,
    planned_entry_price,
    initial_stop_price,
    risk_multiplier,
    execution/account context,
) -> calculated_quantity
```

Stage A реализация — `FixedMinimumPositionSizeCalculator`: возвращает **minimum
executable quantity** для инструмента. **UPDATED — correction pass 5:** "executable"
означает пройденной проверку **и** по `min_order_qty`/`qty_step`, **и** по
`min_notional_value` (см. ниже) — без учёта нотионала заявленная "минимальность" была бы
ложной, т.к. заявка, прошедшая только qty-проверки, всё ещё может быть отклонена биржей
из-за недостаточной notional-стоимости (`qty × planned_entry_price < min_notional_value`).
Литерал `0.001` (или любой другой fixed qty) **не встраивается** непосредственно в
`EntryPackageApplicationService` — сервис всегда вызывает calculator через порт.

```
EntryPackageApplicationService → всегда вызывает PositionSizeCalculator
Stage A implementation         → calculator возвращает minimum executable quantity
future sizing change           → заменяет calculator implementation;
                                   public entry-package API и application service
                                   не меняются
```

`risk_multiplier` передаётся в calculator port уже в Stage A, несмотря на то что
placeholder implementation пока не изменяет результат на его основе — это сохраняет один
стабильный вызов на будущее вместо двух разных путей до и после появления настоящего
sizing.

Пересмотренные ответы на исходные 6 подвопросов:

1. Fixed/minimum qty остаётся честным для контракта — `calculated_quantity` требует
   только "exact-decimal string", не корректность относительно `risk_multiplier`.
2. Полноценный risk-based sizing по-прежнему не prerequisite для честности контракта в A
   — но теперь это явный **launch gate для mainnet/live readiness** (§27), а не просто
   отложенный roadmap-пункт.
3. Человеко-читаемое раскрытие (README/docs) остаётся обязательным, но **отдельное
   machine-readable поле в public entry-package response не требуется** (см. §28e,
   resolved) — placeholder sizing прозрачен через сам факт стабильности `calculator`
   boundary до появления настоящего sizing engine.
4. **REJECTED:** "ABI может игнорировать `risk_multiplier` в ready production mode".
   Новая формулировка: `risk_multiplier` **всегда** проходит через стабильный sizing
   boundary; placeholder calculator сегодня возвращает minimum quantity независимо от его
   значения; но само прохождение через порт обязательно, и полноценная production risk
   semantics — deferred launch gate, а не игнорируемая деталь.
5. Доступные сегодня данные не меняются: `getWalletBalance()` не используется, stop
   distance вычислим, ничего не считает equity-based sizing.
6. Вынос sizing из A остаётся верным, но теперь оформлен как явный architectural boundary
   (`PositionSizeCalculator` port + `FixedMinimumPositionSizeCalculator` placeholder), а
   не как "просто оставить как есть, не трогать" — ключевое отличие от первой версии
   аудита.

Честно зафиксировано:
- placeholder sizing не является настоящим risk-based sizing;
- Stage A допустим для demo/testnet и cross-service development;
- mainnet/live readiness остаётся gated отдельной реализацией risk-based sizing (§27);
- существующий `calculated_quantity` success field сохраняется без изменений;
- `risk_multiplier` не возвращается в success response (как и раньше).

> **Review update — InstrumentTradingRulesProvider (закрывает §28f).**
> `FixedMinimumPositionSizeCalculator` должен возвращать реально исполнимое количество, а
> не литерал. Вводится отдельный источник торговых правил:
>
> ```
> InstrumentTradingRulesProvider
>
> InstrumentTradingRules
> ├── min_order_qty
> ├── qty_step
> ├── min_notional_value          (ADDED — correction pass 5, закрывает открытый вопрос)
> └── (только реально необходимые constraints — не расширять без нужды)
> ```
>
> **Источник — проверено 2026-07-30 по официальной документации
> ([Get Instruments Info | Bybit API Documentation](https://bybit-exchange.github.io/docs/v5/market/instrument)):**
> `GET /v5/market/instruments-info` (`category=linear`, опционально `symbol`) —
> публичный, **неавторизованный** endpoint; `result.list[].lotSizeFilter.minOrderQty`,
> `.qtyStep` и `.minNotionalValue` — все три строки, одним и тем же уже проверенным
> запросом (никакого дополнительного вызова не требуется). Endpoint нигде не реализован в
> `bybitAdapter.ts` сегодня (там только `getMarketPrice` через `/v5/market/tickers`) —
> нужен новый метод адаптера.
>
> **Формула минимально исполнимого количества (correction pass 5):**
>
> ```
> qty_by_notional = ceil_to_step(min_notional_value / planned_entry_price, qty_step)
> qty_by_min      = ceil_to_step(min_order_qty, qty_step)
> calculated_quantity = max(qty_by_min, qty_by_notional)
> ```
>
> Обе величины округляются вверх до ближайшего кратного `qty_step` (не вниз — округление
> вниз могло бы снова опустить количество ниже минимума), затем берётся максимум. Это
> гарантирует, что `calculated_quantity` проходит все три известных Bybit-ограничения
> одновременно. `planned_entry_price` уже доступен `PositionSizeCalculator` через
> существующую сигнатуру порта (§6) — новых входных данных не требуется.
>
> **Dependency note (correction pass 4, закрывает часть §28 dependency), не design.**
> Bybit endpoint принимает параметр `symbol` (например `BTCUSDT`), а entry-package
> получает Runtime `ticker` (например `BTCUSDT.P`, суффикс подтверждён каноническим spec
> — "Canonical Runtime ticker with suffix is accepted"). Ниже "per-ticker lookup" на самом
> деле означает "per resolved-Bybit-symbol lookup" — `InstrumentTradingRulesProvider`
> потребляет уже разрешённый `symbol`, не сырой `ticker`. Преобразование `ticker → symbol`
> — **отдельная ABI-wide instrument identity concern**, не специфичная для sizing или для
> entry-package execution; в кодовой базе сегодня нет такой нормализации ни в
> легаси-flow (`symbol` там приходит уже exchange-ready), ни где-либо ещё. **Stage A не
> проектирует это преобразование внутри entry-package execution** — оно либо уже должно
> существовать как отдельный shared-компонент, либо является prerequisite work вне рамок
> этого change. См. §17 (non-scope) и §28 (dependency note).
>
> Дизайн-решения (для части после разрешения `ticker → symbol`):
> - **Lazy per-resolved-symbol lookup, не eager startup sweep.** В отличие от legacy
>   signal flow, entry-package `ticker` — непрозрачная Runtime-owned строка без
>   allowlist-проверки (канонический spec: "ABI SHALL impose no ... derivation rule"),
>   поэтому фиксированный eager-список для префетча не имеет естественной границы. Правила
>   запрашиваются при первом использовании и кешируются в памяти.
> - **Cache lifetime:** TTL (часы, не постоянно на весь процесс) — правила биржи меняются
>   редко, но реально (Bybit docs: "adjusted bi-monthly, 3rd and 17th, 08:00 UTC+8");
>   постоянный process-lifetime кеш рискует молча использовать устаревшие правила. Точное
>   значение TTL — design-level деталь, не блокирует propose.
> - **Readiness:** сбой получения правил для конкретного тикера проваливает **эту
>   команду** (`internal_error`, ничего не отправляется на биржу) — НЕ весь `/health`.
>   Отличается от correlation-store readiness (§14, whole-service gate): instrument rules
>   — внешние, per-symbol, best-effort-кешируемые данные, не локальное durable state.
> - **Exact-decimal:** нормализация количества к `qty_step` (включая `qty_by_notional` из
>   формулы выше) обязана оставаться exact-decimal (без конверсии через `Number()`, как
>   уже принято в `entryPackageApi.ts`) — наивное переиспользование `Number()`-паттерна из
>   `riskGuard.ts` нарушило бы эту дисциплину. **Уточнение (correction pass 5):**
>   `min_notional_value / planned_entry_price` — деление, которое в общем случае не даёт
>   конечной десятичной дроби; корректная exact-decimal реализация обязана делить с явным
>   округлением вверх до нужной точности (round-up division), не конвертировать через
>   `Number()`/бинарную плавающую точку ни на одном шаге — конкретная decimal-библиотека
>   или ручная long-division реализация решается на уровне implementation, не audit.
> - **Ownership:** `PositionSizeCalculator` (не сам provider) владеет финальным
>   rounding/step-normalization; provider отдаёт только сырые constraints.
> - **Test fake:** `FakeInstrumentTradingRulesProvider`, аналогично уже существующему
>   `test/fakes/fakeBybitAdapter.ts`.
> - **Static config fallback:** допустим как override (не primary source) для окружений
>   без live query — тот же паттерн, что уже используют env-driven fallback'и в
>   `config.ts`.

## 7. Per-cycle order identity (UPDATED — resolved against official Bybit docs)

`buildOrderLinkId(instanceId, "entry")` хеширует **только** `instanceId`. Два
последовательных `trade_cycle_id` под одним `strategy_instance_id` дают идентичный
`orderLinkId`, детерминированно, всегда. Однозначно непригодно.

**Рекомендация: детерминированный хеш `(strategy_instance_id, trade_cycle_id, role,
generation)`**, не persisted-generated значение. Чистый хеш без `generation` недостаточен
для REPLACE через cancel-and-create: новый ордер того же цикла обязан получить **новый**
`orderLinkId`, отличный от предыдущего, иначе события старого и нового ордера
неразличимы, а `binding_history[]` (§8) не сможет их разделить.

```
order_link_id = hash(strategy_instance_id, trade_cycle_id, role, generation)
```

Обоснование детерминированности не изменилось: переживает restart без I/O, безопасна для
retry/reconciliation (§9/§12), совпадает с существующим паттерном кодовой базы.

**Generation convention — закрыто в этом correction pass:**
- Generation — **1-based**: первый create цикла = `generation = 1`. `0`/unset
  зарезервирован как sentinel "ещё не создан ни один ордер".
- `generation` **резервируется и durable-сохраняется до** внешнего create call — значение
  фиксируется в момент persist provisional record (§9/§11 шаг 1), не в момент ответа
  биржи.
- `amend-in-place` (REPLACE через amend) сохраняет текущую `generation` и текущий
  `order_link_id` — тот же физический ордер.
- `cancel-and-create` (REPLACE через пересоздание) резервирует **следующую** generation
  (`n+1`) и, следовательно, новый `order_link_id`.
- Повтор ambiguous/timeout попытки **использует уже зарезервированную** `generation` — не
  создаёт новую. Retry ≠ replace.
- Новая generation создаётся **только** при физически новом exchange-ордере, никогда — из-
  за caller retry.
- History старых bindings (`binding_history[]`, §8) сохраняется без ограничения времени
  для Stage B.

**Bybit `orderLinkId` ограничения — проверено 2026-07-30 по официальной документации:**
- Максимальная длина: **36 символов** ([Place Order | Bybit API Documentation](https://bybit-exchange.github.io/docs/v5/order/create-order)).
- Алфавит: цифры, буквы (upper/lower), `-`, `_`.
- Uniqueness: "must always be unique" — точное окно (rolling vs permanent) официальная
  страница не уточняет.
- Наблюдаемое расхождение: сторонний баг-репорт ([passivbot#436](https://github.com/enarjord/passivbot/issues/436))
  фиксирует ошибку биржи `"order link id is longer than 45"`, что не совпадает с
  задокументированными 36 символами; причина расхождения не выяснена. **Не блокирует Stage
  A**: текущая схема `abi-entry-${sha256(...).slice(0,20)}` = 30 символов; добавление
  generation держит итоговую длину заметно ниже 36 — безопасно относительно обоих
  наблюдаемых пределов.
- Amend endpoint официально подтверждён ([Amend Order | Bybit API Documentation](https://bybit-exchange.github.io/docs/v5/order/amend-order)):
  amendable — `qty`, `price`, `triggerPrice`, `takeProfit`, `stopLoss`, `tpslMode`,
  `tpTriggerBy`, `slTriggerBy`, `triggerBy`, `tpLimitPrice`, `slLimitPrice`, `orderIv`
  (options only). `side`, `orderType`, `symbol`, `triggerDirection` — **не в списке**,
  подтверждает более раннюю инференцию из типа `BybitAmendOrderPayload` в кодовой базе.
  Дополнительно подтверждено: amend работает только для **unfilled/partially-filled**
  ордеров — terminal-ордер требует cancel-and-create, не amend (используется в §12).

Это закрывает §28b как разрешённый.

## 8. Correlation aggregate design

Первичная идентичность: **композит `(strategy_instance_id, trade_cycle_id)`**, не
`order_link_id` (у одного цикла может быть несколько orderLinkId за жизнь через
cancel-and-create replace).

```
EntryPackageExecutionRecord (единственный append-only file, §11;
                              каждая строка — ПОЛНЫЙ snapshot, ключ — композит)
├── strategy_instance_id, trade_cycle_id   (immutable)
├── created_at                             (immutable)
├── desired_entry, calculated_quantity     (mutable — текущее желаемое состояние)
├── order_link_id, order_id | null         (mutable — текущий live binding)
├── generation                             (mutable, 1-based — см. §7)
├── status: pending_create | applied | pending_replace |
│           pending_cancel | absent | create_failed | unknown |
│           terminal_unfilled (ADDED — correction pass 5, см. §12: applied ранее,
│                               но exchange terminated без fill; repeat non-null PUT
│                               fails closed из этого статуса, только CANCEL разблокирует)
├── early_execution_observation | null     (mutable — aggregate observation, НЕ
│                                            fill-level факты; durable до Stage B
│                                            delivery, см. §24/§26):
│                                            {order_status, cumulative_filled_qty,
│                                             remaining_qty, avg_execution_price?,
│                                             observed_at}
├── binding_history[]                      (embedded, append-only внутри записи,
│                                            НИКОГДА не усекается:
│                                            {order_link_id, order_id, generation, role,
│                                             started_at, ended_at,
│                                             end_reason: replaced|cancelled|superseded})
└── updated_at
```

**UPDATED (correction pass 4).** Поле переименовано из `execution_facts` в
`early_execution_observation` и его содержимое сужено: Stage A хранит только
**агрегированное** наблюдение состояния ордера на момент bounded confirmation —
`order_status`, `cumulative_filled_qty`, `remaining_qty`, `avg_execution_price` (если
доступна на этот момент), `observed_at`. Это одна снятая снапшот-величина, не поток
событий. **Individual fills, first-fill determination и execution-history recovery
явно принадлежат Stage B** — Stage A не пытается реконструировать последовательность
отдельных исполнений, только текущее агрегированное состояние на момент наблюдения.

История больше не отдельный файл — каждая строка correlation-файла есть ПОЛНЫЙ снапшот
записи, включая embedded `binding_history[]` и `early_execution_observation`.
Diff-записи не используются. Точная durable commit boundary — §11.

Unique constraint: `(strategy_instance_id, trade_cycle_id)`. Confirmed-absence —
реальная строка `status: "absent"`, не удалённая строка (удаление сломало бы
idempotency fast-path и историческую цепочку для Stage B).

> **Review update — WebSocket binding race (UPDATED, см. §22–§24).** Provisional record
> должен быть доступен для lookup по `order_link_id` **сразу после шага 1** (persist
> provisional, до вызова Bybit create), потому что future Stage B WebSocket consumer
> может получить order-topic push с этим `orderLinkId` раньше, чем синхронный
> REST-ответ на create успеет вернуться и присоединить `order_id`. Значит: lookup by
> `order_link_id` обязан работать уже на provisional-записи, а `order_id` — поле, которое
> **присоединяется** к уже существующему binding, а не создаёт его.

## 9. Persistence и порядок внешних вызовов

Предложенный 6-шаговый порядок в целом верен и отражает существующий pre/post-snapshot
паттерн `verifyPostCreateProtection`.

- **Что можно сохранить до внешнего вызова:** всё, что прислал Runtime, плюс выведенный
  детерминированный `order_link_id`.
- **Pre-write успешен, create упал:** пометить `create_failed` (или откатить к
  предыдущему confirmed снапшоту при replace).
- **Create успешен, post-write упал (реальный ambiguous случай):** нужен статус
  `pending`/`unknown`. Разрешается той же детерминированной деривацией — повторный PUT
  или lazy reconciliation запрашивает Bybit по тому же `order_link_id`.
- **Query по orderLinkId после сбоя:** всегда возможен.
- **Безопасный retry PUT:** да, именно благодаря детерминированной identity — это и есть
  механизм идемпотентности (§12).
- **Минимум recovery для A:** persist provisional record до любого вызова Bybit; никогда
  не возвращать `entry_package_applied` при ambiguous исходе (вместо этого
  `internal_error`).
- **Явно отложено:** background reconciliation workers, transactional outbox,
  cross-process locking.

Общий transactional outbox не требуется — детерминированная identity уже даёт основную
гарантию, которую он бы обеспечивал.

## 10. Confirmation procedure

`verifyPostCreateProtection` + `decideProtectionCheck` — сильнейший существующий актив,
но отвечает на **другой вопрос** ("существует ли ордер/позиция вообще, была ли пробита
stop"), никогда не сверяя фактические значения полей.

Entry-package confirmation нужна **новая** часть: после create/amend распарсить ответ
`getOrderByLinkId` и сравнить `triggerPrice`/`qty`/`stopLoss`/`takeProfit` с
отправленными, в том же bounded-retry окне.

**Важная граница scope:** confirmation для entry-package — это *pending-order
field-accuracy verification*, не *post-fill protection verification*. Это разные задачи,
хотя используют одинаковую query-механику; fill-handling уже правильно исключён из
non-scope.

> **Review update.** Confirmation state machine расширена сценариями fill-before-ack —
> см. §26 (Expanded Stage A confirmation outcomes), которая уточняет упрощённое
> "presence-only" понимание этого раздела применительно к раннему исполнению.

## 11. Storage design — durable commit boundary (UPDATED — correction pass)

Нет ни одной DB-зависимости в `package.json`. Одного тезиса "JSONL append/replay"
недостаточно — ниже точная durable commit boundary Stage A.

Расширение `Journal` на месте (Вариант A) по-прежнему не рекомендую: его публичный API
signal-ориентирован, нужная форма lookup не ложится на "сканировать каждую строку каждый
раз".

**Модель: один append-only correlation file** (не два, как в предыдущей версии). Каждая
строка — **полный** снапшот `EntryPackageExecutionRecord`, включая embedded
`binding_history[]` и `early_execution_observation` (§8, UPDATED — correction pass 4).
Отдельный `CorrelationRepository` использует
те же низкоуровневые примитивы, что уже доказаны в `Journal` (вынести shared I/O helper,
не сам класс). При открытии — replay файла, оставляя последнюю валидную строку на ключ.

**Durable write sequence — обязательна для КАЖДОГО перехода статуса, включая provisional
persist на шаге 1 из §9:**

```
1. serialize complete record (весь EntryPackageExecutionRecord, не diff)
2. append serialized record + "\n" одним write()-вызовом
3. fsync (явный — Node НЕ делает fsync по умолчанию ни в appendFile, ни в write)
4. update/confirm in-memory indexes (composite key, order_link_id, order_id)
5. только теперь HTTP 2xx (entry_package_applied ИЛИ entry_package_absent) разрешён
```

Шаг 3 — сознательное расхождение с `Journal.appendEvent` (`appendFile` без fsync,
приемлемо для advisory audit log, неприемлемо для correctness-critical correlation
store). В Node: `fsPromises.open(path, 'a')` → `handle.appendFile(...)` → `handle.sync()`
→ `handle.close()` (либо `fs.write` + `fs.fsync`). Это добавляет реальную latency на
запись (диск-flush), но entry-package PUT — не high-frequency путь; цена оправдана
инвариантом ниже.

**Почему не SQLite:** JSONL + explicit-fsync-per-append уже даёт требуемую гарантию без
новой зависимости. SQLite остаётся опцией только при будущей реальной query-сложности
или конкурентном multi-writer доступе, которых Stage A (single-process,
keyed-mutex-serialized) не имеет.

**Два разных вида сериализации — уточнение, не было в предыдущей версии:**
- **Per-key keyed mutex** (§25) сериализует *бизнес-логику* read-modify-write одного
  `(strategy_instance_id, trade_cycle_id)`.
- **Repository write queue** (новое явное требование) сериализует *физические append* в
  единый файл — нужен ОТДЕЛЬНО от keyed mutex, потому что разные ключи пишут в один и тот
  же файл; без этого конкурентные append разных ключей могут переплестись на уровне
  байтов записи. `CorrelationRepository` держит внутреннюю FIFO-очередь на все append,
  независимо от ключа.

**Crash / corruption matrix:**

| Ситуация | Поведение |
|---|---|
| crash во время append (до конца write/fsync) | последняя строка файла может быть частичной; при replay это **допустимая truncated-tail** — отбросить непарсящуюся последнюю строку, откатиться к предыдущей валидной строке для этого ключа |
| corrupt non-final record | **readiness failure** (сознательное расхождение с Journal, §14) — не soft-skip, т.к. может скрыть live exchange-ордер от bookkeeping ABI |
| concurrent save одного ключа | предотвращено keyed mutex (§25) — на уровне repository не должно происходить в принципе; write queue защищает даже при нарушении контракта на уровне вызова |
| lookup by cycle (`strategy_instance_id`+`trade_cycle_id`) | O(1) по in-memory индексу, построенному при replay |
| lookup by `order_link_id` | O(1) по in-memory индексу, включает исторические (superseded) bindings из `binding_history[]`, не только текущий |
| lookup by `order_id` | O(1) по in-memory индексу, аналогично включает историю |
| durability до `entry_package_applied` | обязательна — шаг 3 завершается до шага 5 |
| durability до `entry_package_absent` | обязательна аналогично, даже когда внешний Bybit-вызов не потребовался (confirm-absence без create) |

**Главный invariant:**

```
exchange package confirmed
AND correlation/execution state durably committed
→ success response allowed
```

## 12. Idempotency повторного PUT (UPDATED — correction pass 5, закрывает §28d, меняет terminal-без-fill семантику)

> **Review update.** Предыдущее правило "тот же пакет + status=applied → no-op без
> exchange observation" **отменено до появления Stage B**. Заменено обязательной bounded
> revalidation.

Любой повторный PUT с тем же `desired_entry`, пока локальный статус — `applied`, теперь
**всегда** выполняет bounded exchange revalidation и классифицирует результат прежде, чем
вернуть правдивый ответ:

| Классификация после revalidation | Ответ |
|---|---|
| pending package всё ещё совпадает (live, поля совпадают) | `entry_package_applied` |
| partial/full fill подтверждён | сохранить `early_execution_observation` (durable, §8/§11) → `entry_package_applied`; наблюдение остаётся pending для будущей Stage B Runtime delivery |
| terminal без fill (например ручная отмена оператором на бирже вне ABI) | **REVISED — correction pass 5, решение B принято явно.** См. блок ниже — больше не auto-recreate |
| contradictory/unknown (наблюдения биржи противоречат друг другу или недостаточны для bounded классификации) | `internal_error`, no fabricated 2xx |

### Terminal без fill — принятое решение B: fail closed, без auto-resurrection (correction pass 5)

> **REJECTED (correction pass 5).** Предыдущая версия этого раздела предписывала
> **reconcile-через-recreate**: при обнаружении, что ранее применённый пакет стал
> terminal без fill, ABI автоматически создавала новую generation и заново выставляла
> ордер в том же `trade_cycle_id`, возвращая `entry_package_applied` для нового ордера.
> Это было спорной бизнес-семантикой, не принятой явно, а не выведенной из контракта или
> кода — отменяется.

Принятое V1-решение (Вариант B из трёх рассмотренных: A — auto-recreate, B — сохранить
terminal state и fail closed, C — отложить до Stage B/recovery design):

```
correlation record status → новый статус: terminal_unfilled (добавлен в §8 schema)

Repeat PUT с ЛЮБЫМ non-null desired_entry (тем же ИЛИ изменённым),
пока status = terminal_unfilled
→ НЕ создавать новую generation автоматически
→ НЕ выставлять новый ордер
→ пометить старую generation terminal в binding_history[] (факт сохраняется)
→ вернуть internal_error, no fabricated 2xx

Repeat PUT с desired_entry = null (CANCEL/confirm-absence),
пока status = terminal_unfilled
→ РАЗРЕШЕНО — это не resurrection, это признание уже существующей реальности
  (ничего живого на бирже и так нет)
→ status → absent

Следующий non-null PUT ПОСЛЕ подтверждённого absent
→ обычный CREATE путь (§5) — новая generation, явный Runtime-initiated re-entry,
  а не тихое авто-восстановление ABI
```

Это буквально реализует "не воскрешать ордер автоматически в старом цикле": единственный
путь из `terminal_unfilled` обратно к живому ордеру — явный, видимый Runtime двухшаговый
цикл (CANCEL → CREATE), а не скрытая логика внутри одной bounded revalidation. Точный
механизм, которым Runtime узнаёт о необходимости отправить этот CANCEL (например через
будущий Stage B execution-event, или через ручное обнаружение операторами) — вне ABI's
control и вне scope этого audit; ABI со своей стороны обязан лишь честно не выдавать
`entry_package_applied` за то, чего нет, и не предпринимать одностороннего действия.

**Остаточный, явно deferred, non-blocking design-вопрос:** нужен ли отдельный recovery
endpoint/механизм для явного "разблокирования" `terminal_unfilled`-цикла помимо
CANCEL-затем-CREATE (например для операторского UI) — не решается в этом audit, не
блокирует propose.

Остальные строки не меняются:

| Сценарий | Поведение | Почему |
|---|---|---|
| тот же пакет, status=pending/unknown | bounded reconciliation query (§9) | безопасно разрешает crashed/ambiguous попытку через детерминированную identity |
| изменённый пакет после success | REPLACE (amend или cancel-and-create, §5) | |
| desired=null после success | CANCEL | |
| дубликат после caller timeout | как строка "pending" выше | |
| restart между запросом/ответом | как строка "pending" выше, разрешается лениво (§14) | |

Существующей пары `(strategy_instance_id, trade_cycle_id)` достаточно как ключа
идемпотентности — новый `command_id` не нужен.

## 13. Replace/cancel история

Минимальное правило: **никогда не удалять** маппинг `{order_link_id, order_id}` —
добавлять в embedded `binding_history[]` (§8, UPDATED — теперь часть каждого полного
snapshot-снимка, не отдельный файл) при каждом replace/cancel, с end reason. Это даёт
Stage B возможность корректно резолвить позднее/устаревшее событие для уже неактуального
ордера обратно к правильному `(strategy_instance_id, trade_cycle_id)`.

## 14. Startup / restart / readiness

- Store открывается через полный replay файла до того, как route начнёт обслуживать
  трафик.
- **Сознательное расхождение с Journal:** непарсируемая строка = readiness failure, не
  skip. Journal — advisory/audit, этот store — то, что делает `entry_package_applied`
  честным.
- Recovery pending/unknown записей: рекомендую **ленивую** (на следующий touch
  конкретного `trade_cycle_id`), не eager startup sweep. Ничего небезопасного в записи в
  состоянии `unknown` — инвариант лишь в том, что ABI не должен claim'ить `applied` до
  reconciliation.
- `ready=true` с нечитаемым store: **нет.**
- Execution до окончания recovery: **нет** — но для файлового JSONL replay это не
  реальная задержка при ожидаемых объёмах.
- Уже живые ордера на Bybit никак не затрагиваются рестартом ABI; задача ABI — корректно
  восстановить собственное представление.

## 15. Public API impact (UPDATED — correction pass 3, REVERTS prior "request delta" conclusion)

**Изменений публичного Engine → Runtime → ABI контракта для Stage A не требуется.**
APPLY/REPLACE/CANCEL/confirm-absence, order identity, correlation state, confirmation-
механика и **trigger-direction mapping** (§5, UPDATED) — всё внутреннее для ABI. Два
существующих success DTO по-прежнему полностью покрывают нужные Runtime исходы.

> **Correction pass 3.** Предыдущий вывод "требуется расширение request-стороны
> контракта (`trigger_direction`)" **отменяется**. §5 больше не доказывает неполноту
> `DesiredEntry` — trigger-direction mapping закрыт как ABI-owned V1 execution decision,
> без нового транспортного поля. `DesiredEntry.side` остаётся без изменений.

Не добавлять в request или response DTO:
`trigger_direction`, `entry_mechanic`, `execution_profile`, Bybit `triggerDirection`,
`order_id`, `order_link_id`, execution phase, correlation record id, risk-multiplier
echo, internal workflow status.

## 16. Component ownership (UPDATED — correction pass 3, добавлен EntryOrderSemanticsMapper)

```
HTTP route (entryPackageRoutes.ts)
   │  валидирует только transport, вызывает сервис, сериализует результат
   ▼
Keyed mutex (новый — см. §25)
   │  сериализует по (strategy_instance_id, trade_cycle_id); in-process only,
   │  т.к. multi-process ABI вне scope (§17)
   ▼
EntryPackageApplicationService                 (новый)
   │  загружает correlation record → решает APPLY/REPLACE/CANCEL/confirm-absent
   │  → вызывает EntryOrderSemanticsMapper(side) (новый — correction pass 3, см. §5)
   │  → вызывает PositionSizeCalculator (см. §6)
   │  → строит plan + Bybit payloads (переиспользует executionPlan.ts / bybitOrderMapper.ts)
   │  → persist provisional record → вызывает guarded exchange функции (execution.ts, как есть)
   │  → bounded confirmation (PackageConfirmationComponent, новый — расширяет
   │     verifyPostCreateProtection, теперь включая fill-before-ack исходы, см. §26)
   │  → persist confirmed/failed state → передаёт в serializeApplied/AbsentEntryPackage (уже написаны)
   ▼
CorrelationRepository (новый)   PositionSizeCalculator      EntryOrderSemanticsMapper       ExchangeGateway =
  владеет file lifecycle,        (новый порт; Stage A:      (новый, чистый — correction    RestBybitAdapter +
  replay, lookup по composite     FixedMinimumPositionSize-  pass 3):                        execution.ts
  key И по order_link_id (§8),    Calculator; future sizing  map(side) -> EntryOrderSemantics (как есть)
  readiness signal                меняет только эту          {exchange_side: Buy|Sell,
                                   implementation)             trigger_direction: rises_to|falls_to}
                                                               V1: long→Buy,falls_to;
                                                               short→Sell,rises_to
```

**`EntryOrderSemanticsMapper` — контракт и требования (закрывает §5):**

```
map(side: long | short) -> EntryOrderSemantics

EntryOrderSemantics
├── exchange_side: Buy | Sell
└── trigger_direction: rises_to | falls_to

V1 implementation:
long  → Buy,  falls_to
short → Sell, rises_to
```

Далее существующий/адаптированный Bybit mapper (`bybitOrderMapper.ts`) преобразует
internal enum в Bybit-числовой код: `rises_to → 1`, `falls_to → 2` (уже существующая
`mapTriggerDirection` в кодовой базе). `EntryOrderSemanticsMapper` обязан быть:
чистым; детерминированным; независимым от live market price; независимым от времени
повторного PUT; покрытым unit-тестами (§18); отдельным от transport validation
(`entryPackageApi.ts`); отдельным от Bybit REST adapter (`bybitAdapter.ts`).

`EntryPackageApplicationService`:
- читает `DesiredEntry.side`;
- вызывает `EntryOrderSemanticsMapper`;
- **не** сравнивает entry price с market price;
- **не** содержит `if long then Bybit numeric 2` непосредственно;
- **не** принимает Bybit-specific decisions самостоятельно — это делегировано mapper'у.

HTTP route не должен трогать correlation state, Bybit или persistence напрямую — это
ограничение уже существует как выполненная задача в архивном change (`tasks.md` 2.3).

> **Review update — Stage B interface awareness (не входит в scope A, см. §17/§23).**
> Будущий WebSocket order/execution consumer будет читать через тот же
> `CorrelationRepository` lookup-by-`order_link_id`, что и `EntryPackageApplicationService`
> — поэтому репозиторий должен поддерживать этот lookup уже в A, даже если сам consumer
> строится в Stage B.

## 17. Recommended A scope / non-scope (UPDATED — correction pass 3)

Согласен с предложенными границами, плюс уточнения:
- **Добавить в scope явно:** deterministic ABI-owned V1 entry-order semantics mapping для
  текущей поддерживаемой EMA-pullback geometry (`EntryOrderSemanticsMapper`, §5/§16) —
  реальный новый компонент, но полностью ABI-internal, без cross-repo зависимости.
- **Добавить в non-scope явно:** risk-based sizing (§6), при условии
  readiness-disclosure.
- **Добавить в non-scope явно (correction pass 3):** generic multi-strategy entry-
  mechanic contract; breakout-specific direction semantics; cross-repo расширение
  `DesiredEntry`; future execution-profile discriminator (§5, "future compatibility
  gate" — deferred, не проектируется превентивно).
- **Добавить в non-scope явно (correction pass 4):** преобразование Runtime `ticker` →
  Bybit `symbol` (например снятие суффикса `.P` из `BTCUSDT.P`). Это отдельная ABI-wide
  instrument identity concern, не специфичная для entry-package. В кодовой базе сегодня
  нет никакой нормализации ticker↔symbol (подтверждено grep'ом — ни в `src/`, ни в
  архивных OpenSpec change). Stage A **не проектирует** это преобразование внутри
  entry-package execution — см. §6 (где эта зависимость впервые всплывает через
  `InstrumentTradingRulesProvider`) и §28 (dependency note).

Остальной non-scope список подтверждается кодом.

> **Correction pass 3.** Prerequisite-зависимость от cross-repo `trigger_direction`
> change (введённая предыдущим review pass) **удалена**. Trigger-direction семантика для
> поддерживаемого V1 contour — ABI-internal scope, не внешняя зависимость.

> **Уточнение границы fill-handling (UPDATED — correction pass 4).** *Персистентное
> сохранение* агрегированного `early_execution_observation` (order_status,
> cumulative_filled_qty, remaining_qty, avg_execution_price?, observed_at — §8 UPDATED),
> которое могло быть получено до возврата `entry_package_applied` (§24/§26), входит в
> scope A как часть durable correlation record. **Individual fills, first-fill
> determination и execution-history recovery явно принадлежат Stage B**, не Stage A —
> это более узкая граница, чем предыдущая формулировка "first-fill/cumulative facts".
> *Управление* открытой позицией/жизненным циклом филла (partial/full fill state
> application, open-trade management) по-прежнему остаётся вне scope A. Разграничение:
> сохранить агрегированное наблюдение vs реконструировать историю fills vs действовать по
> факту.

## 18. Acceptance matrix (UPDATED — correction pass, расширена)

### Core (исходный список, не изменился)

| Сценарий | Уровень |
|---|---|
| первый APPLY success | contract + integration-fake-bybit |
| идентичный повторный APPLY | unit + integration-fake-bybit |
| REPLACE через amend | integration-fake-bybit |
| REPLACE через cancel-and-create | integration-fake-bybit |
| успешный CANCEL | integration-fake-bybit |
| already-absent CANCEL | unit |
| create transport failure | unit |
| create accepted, confirmation failed | integration-fake-bybit |
| partial package observation | unit |
| correlation pre-write failure | unit |
| correlation post-create write failure | unit |
| caller timeout + repeated PUT | integration-fake-bybit |
| restart с confirmed record | integration |
| restart с provisional record | integration |
| старое order event после replacement | future Stage B |
| invalid configuration/readiness | unit |
| fixed quantity корректно раскрыт | contract |
| никаких fabricated 2xx | contract (все error paths) |
| real demo smoke | manual/scripted, аналог `smoke:sandbox:*` |

### Identity/concurrency (новое)

| Сценарий | Уровень |
|---|---|
| first generation create (generation=1) | unit |
| amend сохраняет generation | unit |
| cancel-and-create инкрементирует generation | integration-fake-bybit |
| caller retry не инкрементирует generation | unit |
| concurrent identical PUT создаёт один exchange order | integration (keyed mutex) |
| concurrent changed PUT сериализуется за первым запросом | integration (keyed mutex) |
| late event для старой generation резолвится в правильный history binding | future Stage B (дизайн проверяется уже в A) |

### Durability (новое)

| Сценарий | Уровень |
|---|---|
| provisional durable commit до create | unit (repository) |
| write failure до внешней команды | unit |
| external command accepted + сбой confirmed-state write | integration-fake-bybit |
| crash во время финального append | unit (repository, truncated-tail симуляция) |
| truncated final record при restart | unit (repository) |
| corrupt non-final record проваливает readiness | unit (repository) |
| restart восстанавливает текущий и исторические bindings | integration |
| нет HTTP 2xx до fsync/durable commit | contract |

### Confirmation (расширено §26)

| Сценарий | Уровень |
|---|---|
| pending package поля совпадают | unit |
| pending package поля не совпадают | unit |
| partial fill до acknowledgement | integration-fake-bybit |
| full fill до acknowledgement | integration-fake-bybit |
| rejected/deactivated до любого fill | unit |
| ambiguous order observation | unit |
| attached protection неполная | unit |

### Repeated PUT (расширено §12)

| Сценарий | Уровень |
|---|---|
| тот же applied request с live pending order | integration-fake-bybit |
| тот же applied request после partial fill | integration-fake-bybit |
| тот же applied request после full fill | integration-fake-bybit |
| тот же applied request после ручной отмены (terminal без fill) → status=terminal_unfilled, `internal_error`, НЕ auto-recreate (correction pass 5, было auto-recreate) | integration-fake-bybit |
| изменённый (не тот же) desired_entry при status=terminal_unfilled → тоже `internal_error`, fail closed (correction pass 5) | integration-fake-bybit |
| desired_entry=null при status=terminal_unfilled → разрешено, confirm-absence, status→absent (correction pass 5) | integration-fake-bybit |
| non-null PUT после подтверждённого absent (был terminal_unfilled) → обычный CREATE, новая generation (correction pass 5) | integration-fake-bybit |
| тот же applied request после exchange deactivation → status=terminal_unfilled, тот же fail-closed путь | integration-fake-bybit |
| тот же applied request при противоречивом local/exchange state | unit |

### Sizing (новое, §6)

| Сценарий | Уровень |
|---|---|
| rules provider возвращает min qty, qty step и min notional value | unit (fake provider) |
| minimum quantity нормализуется корректно к qty_step (округление вверх) | unit |
| calculated_quantity удовлетворяет min_notional_value, не только min_order_qty (correction pass 5) | unit |
| qty_by_notional > qty_by_min выбирается корректно (и наоборот) | unit |
| деление для qty_by_notional остаётся exact-decimal, без Number()-конверсии | unit |
| rules недоступны блокируют execution readiness (per-command, не глобально) | unit |
| risk_multiplier доходит до calculator port | unit |
| placeholder calculator остаётся детерминированным | unit |
| нет захардкоженного quantity в application service | contract/static review |

### Readiness boundary (новое, §27)

| Сценарий | Уровень |
|---|---|
| Stage A не выполняет Runtime execution webhook | contract |
| Stage A фиксирует, что независимый live-flow требует Stage B | docs/contract |
| mainnet остаётся gated risk-based sizing | contract |

### Pure mapping — EntryOrderSemanticsMapper (новое, correction pass 3, §5/§16)

| Сценарий | Уровень |
|---|---|
| long маппится в Buy + falls_to | unit |
| short маппится в Sell + rises_to | unit |
| rises_to маппится в Bybit triggerDirection = 1 | unit |
| falls_to маппится в Bybit triggerDirection = 2 | unit |

### Stability (новое, correction pass 3)

| Сценарий | Уровень |
|---|---|
| одинаковый long DesiredEntry всегда даёт falls_to | unit |
| одинаковый short DesiredEntry всегда даёт rises_to | unit |
| изменение live market price не влияет на mapping | unit (нет market-price зависимости в сигнатуре mapper'а — проверяется отсутствием параметра, не только поведением) |
| повторный PUT не меняет trigger direction | integration-fake-bybit |
| restart не меняет trigger direction | integration |
| create-заявка отправляется без сравнения current market price с `planned_entry_price` (correction pass 4) | unit (application service не запрашивает `getMarketPrice` на пути CREATE) + contract |
| create не блокируется и не отклоняется ABI из-за текущей цены (в т.ч. когда trigger price уже "по ту сторону" — принятие/исполнение/отклонение решает Bybit) | integration-fake-bybit |

### Layering (новое, correction pass 3)

| Сценарий | Уровень |
|---|---|
| HTTP route не кодирует numeric Bybit direction | contract/static review |
| EntryPackageApplicationService не сравнивает market price с entry price | contract/static review |
| Bybit adapter не определяет стратегический side | contract/static review |
| Engine/Runtime DTO не расширяются Bybit-specific полями | contract (OpenAPI/DTO diff) |

### V1 scope (новое, correction pass 3, §5)

| Сценарий | Уровень |
|---|---|
| docs/spec явно фиксируют EMA-pullback V1 execution geometry как поддерживаемую | docs/contract |
| future unsupported geometry (breakout и т.п.) не заявлена как поддерживаемая | docs/contract |

> **Correction pass 3.** Cross-repo fixture с `trigger_direction` не добавляется — такого
> поля в контракте больше не будет (§5/§15).

## 19. Recommended OpenSpec split (UPDATED — correction pass 3, REVERTS prerequisite-dependency conclusion)

**`abi-entry-package-execution-v1` → один Stage A OpenSpec change.** Confirmation —
часть того, что делает `entry_package_applied` истинным; разделение вынесло бы claim в
состояние semantically false. Sizing — единственное, что реально можно вынести, но как
*non-scope exclusion* этого change, а не как последовательный gate.

> **Correction pass 3.** Предыдущий вывод "требуется отдельный prerequisite delta к
> `abi-entry-package-api` перед этим change" **отменяется**. Trigger-direction mapping
> (§5) закрыт как ABI-internal V1 decision — публичный контракт не меняется (§15), значит
> никакой предшествующей cross-repo OpenSpec change не требуется. Не создавать отдельные
> proposals в Engine и Runtime.

## 20. Proposed change name & capability tree

`abi-entry-package-execution-v1` может быть предложен непосредственно на основании
принятого audit, без предшествующего change.

```
abi-entry-package-execution-v1

proposal.md
design.md
tasks.md
specs/
  entry-package-execution/spec.md   (НОВАЯ capability — внутреннее application/execution
                                      поведение, отдельно от transport-only
                                      abi-entry-package-api)
```

## 22. Bybit push/pull model (review addendum)

Зафиксированы два независимых источника данных о состоянии ордера.

**Command REST API** — ABI сам вызывает `POST /v5/order/create` / `/amend` / `/cancel`.
Их response означает только *"command accepted for asynchronous processing"* — не
доказывает финальное состояние ордера на бирже (уже отражено в §3, здесь формализовано
явно).

**Private WebSocket push** — Bybit самостоятельно присылает:
- `order` topic: `orderId`, `orderLinkId`, `orderStatus`, `qty`, `cumExecQty`,
  `leavesQty`, `avgPrice`, trigger/protection поля, rejection/cancellation факты —
  источник агрегированного order state;
- `execution` topic: `execId`, `orderId`, `orderLinkId`, `execQty`, `execPrice`,
  `execTime` — источник отдельных fill-фактов.

**REST query/recovery pull** — ABI также может запрашивать current/open orders, order
history, execution history по `orderId`/`orderLinkId`. Применяется для bounded
confirmation, ambiguous outcome recovery, websocket gap recovery, startup reconciliation,
diagnostics. REST order history — не мгновенная authoritative замена push: данные могут
отставать; private WebSocket остаётся предпочтительным real-time источником.

**Существующее состояние кода:** сегодня в ABI нет ни одного WebSocket-клиента —
`bybitAdapter.ts` целиком REST, в `package.json` нет ws-зависимости. Private WebSocket
consumer — полностью новый компонент, относящийся к Stage B (§17 non-scope), но его
data-модель (order/execution topics) уже влияет на схему correlation record в A (§8:
`generation`, lookup by `order_link_id` на provisional-записи).

## 23. Асинхронные application contours (review addendum)

Зафиксированы два независимых ABI workflow:

```
Entry-package command workflow (Stage A)
  Runtime PUT entry-package
  → EntryPackageApplicationService
  → durable provisional correlation
  → Bybit REST command
  → bounded exchange confirmation
  → durable confirmed state
  → entry_package_applied / entry_package_absent

Exchange-event workflow (Stage B)
  Bybit private WebSocket
  → order/execution consumer
  → correlation lookup (by order_link_id / order_id)
  → normalized ABI execution state update
  → future Runtime delivery, owned by Stage B
```

WebSocket consumer работает независимо от HTTP request и может получить order/fill event,
пока entry-package request ещё выполняется — прямая причина race-сценария в §24 и
требования generation/lookup-by-orderLinkId в §7/§8.

## 24. Race: fill до entry_package_applied (review addendum)

Обязательный сценарий, который Stage A должен корректно обрабатывать даже без Stage B:

```
Runtime request starts
→ ABI persists provisional correlation
→ ABI sends Bybit create
→ order triggers/fills
→ ABI наблюдает исполнение (через bounded confirmation query; полноценный push — Stage B)
→ entry-package HTTP request ещё не вернулся
```

Требования к Stage A:
1. Provisional correlation существует **до** внешнего create call (уже отражено в §9,
   шаг 1).
2. Provisional record содержит `strategy_instance_id`, `trade_cycle_id`, `generation`,
   уникальный per-generation `order_link_id` (§7/§8 UPDATED).
3. Lookup по `order_link_id` работает даже до присоединения REST-returned `order_id`
   (§8 UPDATED).
4. Ранний `order_id` присоединяется к уже существующему binding, не создаёт новый.
5. Агрегированное `early_execution_observation` (order_status, cumulative_filled_qty,
   remaining_qty, avg_execution_price?, observed_at — §8 UPDATED, correction pass 4)
   сохраняется без потери — durable, даже если Stage B ещё не доставляет его в Runtime
   (§17 UPDATED). **Individual fills и first-fill determination не реконструируются в
   Stage A** — это Stage B concern (execution-history recovery).
6. Ранний fill **не** отправляется в Runtime до установления ordering из §25 — в Stage A
   доставки в Runtime вообще нет (это забота Stage B), но ordering проектируется уже
   сейчас, чтобы Stage A его не блокировал.
7. ABI **не** возвращает fabricated failure только потому, что package уже успел
   исполниться: если пакет действительно применён и execution достоверно связан,
   `entry_package_applied` остаётся допустимым подтверждением (§26, "Full/partial fill
   before acknowledgement").
8. Но **Stage A без Stage B не обеспечивает дальнейшее уведомление Runtime** и поэтому не
   является самостоятельным live-ready flow (§27).

## 25. Ordering будущей Runtime delivery (review addendum, Stage B)

Обязательный ordering, зафиксированный для Stage B (не реализуется в A, но определяет
ограничения на конкурентность в A уже сейчас):

```
early fill observed
→ persist normalized execution event as pending delivery
→ complete entry-package confirmation
→ return entry_package_applied to Runtime
→ asynchronously deliver pending execution event
```

Запрещено: ABI ждёт обработки Runtime execution-webhook до возврата
`entry_package_applied` — это создаёт deadlock, если Runtime entry-package call
выполняется внутри shared keyed mutex, а future execution webhook должен приобрести тот
же mutex. Stage B delivery происходит только **после** entry-package response boundary;
если webhook приходит, пока Runtime ещё завершает save под mutex, webhook ждёт mutex,
затем читает свежий state.

**Новый компонент, выявленный этим требованием:** per-`(strategy_instance_id,
trade_cycle_id)` keyed mutex/serialization primitive. Сегодня в кодовой базе нет ни
одного mutex-примитива — не требовался, т.к. legacy signal-flow не имеет конкурентных
PUT на один и тот же ключ в этом смысле. Поскольку multi-process ABI явно вне scope
(§17), достаточен **in-process** mutex (например, `Map<string, Promise>` с цепочкой
promise per key) — распределённая блокировка не нужна.

## 26. Expanded Stage A confirmation outcomes (review addendum, расширяет §10)

**Pending order confirmed**
```
order exists in acceptable untriggered/live state
+ qty/trigger/protection match
→ package confirmed → entry_package_applied
```

**Full fill before acknowledgement**
```
correlation confirmed + exchange execution confirmed
+ aggregate early_execution_observation persisted
  (order_status, cumulative_filled_qty, remaining_qty=0,
   avg_execution_price?, observed_at)
→ package was successfully applied and already executed
→ entry_package_applied allowed
→ observation retained for Stage B delivery
  (individual fills / first-fill determination are Stage B concerns, not Stage A)
```

**Partial fill before acknowledgement**
```
correlation confirmed + partial execution confirmed
+ aggregate early_execution_observation persisted
  (order_status, cumulative_filled_qty, remaining_qty>0,
   avg_execution_price?, observed_at)
→ entry_package_applied allowed
→ observation retained for Stage B delivery
  (execution-history recovery deferred to Stage B)
```

**Rejected/deactivated before any fill**
```
package never reached a valid acknowledged state
→ no entry_package_applied → fail safely
```

**Ambiguous observation**
```
cannot prove pending, filled, terminal or absent state
→ internal_error → no success acknowledgement
```

Это прямо расширяет field-accuracy verification из §10: подтверждение больше не бинарное
"found/not found", а классификация среди пяти исходов выше, причём два из них
(full/partial fill) **разрешают** успех при условии, что агрегированное
`early_execution_observation` durable сохранено — это требует нового extraction-кода для
чтения агрегатных полей (`order_status`, `cumExecQty` → `cumulative_filled_qty`, остаток →
`remaining_qty`) даже в рамках bounded REST confirmation (без реального Stage B
WebSocket), поскольку `getOrderByLinkId`/order-history REST-ответ уже может показывать
`cumExecQty` > 0 в
момент confirmation-запроса.

## 27. Stage A readiness conclusion (review addendum)

```
Stage A implementation-ready
but independent live execution is gated until Stage B
```

Причина: после `entry_package_applied` ордер может исполниться или terminate, но без
Stage B Runtime не получает execution state — событие остаётся "запертым" внутри ABI.

Допустимо в рамках A:
- unit/integration development;
- fake Bybit tests;
- controlled demo/testnet smoke с operator awareness;
- Stage B contract development.

Недопустимо: считать A завершённым автономным live trading contour.

Отдельно: mainnet readiness gated настоящим risk-based sizing (§6 UPDATED, launch gate),
независимо от готовности Stage B.

## 28. Нерешённые вопросы (UPDATED — correction pass 5)

**(a) ~~Edge case деривации направления~~ / ~~cross-repo contract gap~~ — RESOLVED,
reversed из BLOCKER.** Trigger direction закрыт как ABI-owned V1 execution mapping (§5):
`long → Buy + falls_to`, `short → Sell + rises_to`, реализовано через
`EntryOrderSemanticsMapper` (§16), детерминированно, без market-price сравнения и без
нового контрактного поля. Это больше не unresolved вопрос и не blocker.

**Deferred non-blocking note (не unresolved вопрос Stage A):** если Strategy Engine в
будущем начнёт публиковать стратегию с другой entry geometry, где `side` недостаточно
для выбора поддерживаемой биржевой механики (например breakout-long, требующий
`rises_to`), потребуется отдельное расширение generic Engine → Runtime → ABI entry
contract либо отдельный execution-profile discriminator. Не блокирует Stage A, не входит
в `abi-entry-package-execution-v1`, не проектируется превентивно (§5, "future
compatibility gate").

**(b) ~~Точные ограничения Bybit `orderLinkId`~~ — RESOLVED.** Проверено 2026-07-30 по
официальной документации (§7): max 36 символов, alphanumeric+`-`/`_`, amend не меняет
`side`/`orderType`/`symbol`/`triggerDirection`. Остаточная деталь: наблюдаемое
расхождение в стороннем баг-репорте (36 vs "longer than 45") — не блокирует, т.к.
рекомендованная схема остаётся безопасно ниже обоих пределов.

**(c) Eager vs lazy startup reconciliation.** Не тронуто этим correction pass. Рекомендую
lazy, но это компромисс между startup latency и окном staleness — не выводится из кода.
**Не блокирует propose** (design-level деталь, по явному указанию review).

**(d) ~~Повторный PUT на `applied`-записи: доверять локальному состоянию или
перепроверять~~ — RESOLVED.** §12 (UPDATED): всегда bounded exchange revalidation,
классификация на 4 исхода (pending matches / partial-full fill / terminal-without-fill →
**decision B: fail closed, correction pass 5** / contradictory → error). "Доверие без
проверки" отклонено до Stage B. Terminal-without-fill ветка изначально (pass 2)
специфицировала auto-recreate — это было отменено correction pass 5 в пользу fail-closed
(§12).

**(e) ~~Machine-readable сигнал fixed-qty disclosure~~ — RESOLVED** (предыдущий pass).
Не требуется; см. §6.

**(f) ~~Источник exchange minimum qty / quantity step~~ — RESOLVED.** §6:
`GET /v5/market/instruments-info` (`lotSizeFilter.minOrderQty`, `qtyStep`), подтверждено
2026-07-30 по официальной документации; полный дизайн `InstrumentTradingRulesProvider`
зафиксирован в §6 (lazy per-ticker lookup, TTL cache, per-command readiness, exact-decimal
normalization, fake provider, static fallback).

**(g) WebSocket reconnect / gap-recovery policy (Stage B).** Не тронуто. §22 фиксирует,
что REST query/recovery pull используется для "websocket gap recovery", но точный
backfill-window, retry/backoff policy и "caught up" критерий не выводятся из текущего
кода — в кодовой базе нет ни одного WS-клиента для прецедента. **Не блокирует propose**
(Stage B, по явному указанию review).

**(h) Точная реализация keyed mutex (§25).** Не тронуто. In-process `Map`-based mutex —
разумный default, но exact API (acquire/release, timeout policy, cleanup error-путей) не
зафиксирован. **Не блокирует propose** (design-level деталь, по явному указанию review).

**(i) Runtime `ticker` → Bybit `symbol` resolution (новое, correction pass 4) —
dependency, не design, решение принято.** Bybit REST endpoints (`instruments-info`,
`order/create`, market/position queries) требуют `symbol` (например `BTCUSDT`);
entry-package получает Runtime `ticker` (например `BTCUSDT.P`, суффикс — часть
канонического transport contract). В кодовой базе нет никакой существующей
ticker↔symbol нормализации (подтверждено grep'ом). Это **отдельная ABI-wide instrument
identity concern**, не специфичная для entry-package execution (§6, §17). **Решение:**
Stage A **не проектирует** это преобразование внутри `abi-entry-package-execution-v1` —
разрешение `ticker → symbol` трактуется как внешняя зависимость (существующий или
отдельно построенный ABI-internal компонент/интерфейс), которую
`EntryPackageApplicationService`/`InstrumentTradingRulesProvider`/`ExchangeGateway`
потребляют, но не реализуют сами. **Это не блокирует `/opsx:propose`** этого change
(в отличие от прежнего trigger-direction blocker'а, это полностью ABI-internal вопрос,
без cross-repo зависимости) — proposal/design для `abi-entry-package-execution-v1` должен
явно зафиксировать это как assumption/prerequisite-интерфейс, а не решать его внутри
своих tasks. Точное владение и построение резолвера — отдельный, вероятно меньший,
параллельный или предшествующий трек работы вне scope этого audit.

**(j) Recovery UX для `terminal_unfilled` (новое, correction pass 5) — deferred,
non-blocking.** §12 фиксирует единственный обязательный путь разблокирования —
явный `CANCEL` (desired_entry=null) → `absent` → новый `CREATE`. Нужен ли вдобавок
отдельный recovery endpoint или operator-UI действие для того же перехода — не решается
в этом audit; design-level деталь, **не блокирует propose**.

Итог: из вопросов (a)–(f) все шесть разрешены (a — reversed из BLOCKER в resolved
correction pass 3; b, d, e, f — resolved предыдущими pass'ами, d дополнительно уточнён
pass 5). Из вопросов (c), (g), (h), (i), (j) все пять явно non-blocking — design-level/
Stage-B детали либо (для (i)) explicit ABI-internal dependency, не требующие решения
внутри этого audit перед propose.

## Audit disposition (UPDATED — correction pass 5, финальная версия)

| # | Original conclusion | Final disposition |
|---|---|---|
| §5 trigger direction | market-price derivation от live snapshot | market-price derivation остаётся **REJECTED**. Промежуточный вывод "escalate в BLOCKER: cross-repo contract gap" (correction pass 2) сам **CORRECTED** correction pass 3: **принят deterministic ABI-owned EMA-pullback mapping** (`long → Buy+falls_to`, `short → Sell+rises_to`) через новый `EntryOrderSemanticsMapper`; cross-repo contract delta признан ненужным для V1 |
| §5 price admission gate | (не рассматривалось отдельно) | **CORRECTED — correction pass 4.** Явно зафиксирован запрет: Stage A не сравнивает current market price с `planned_entry_price` ни для direction (уже закрыто выше), ни как условие допуска/отклонения create-заявки — accept/execute/reject решает Bybit |
| §6 quantity/sizing | fixed qty честен, risk_multiplier можно игнорировать | **CORRECTED** (pass 2) — `risk_multiplier` не игнорируется; добавлен `InstrumentTradingRulesProvider` (min_order_qty, qty_step). **CORRECTED далее (pass 5)** — "minimum executable quantity" была потенциально ложной без учёта `min_notional_value`: заявка, прошедшая только qty-проверки, могла быть отклонена биржей из-за недостаточной notional-стоимости. Добавлен `min_notional_value` в rules и явная формула `max(qty_by_min, qty_by_notional)` с округлением вверх до `qty_step`; название `FixedMinimumPositionSizeCalculator` сохранено, т.к. claim теперь действительно верен |
| §7 order identity | hash(instance, cycle, role) | **CORRECTED** — добавлен `generation` (1-based), Bybit-ограничения подтверждены официально |
| §8 correlation schema | snapshot + отдельный history log (2 файла) | **CORRECTED** (pass 2) — консолидировано в один append-only file. **CORRECTED далее (pass 4)** — поле `execution_facts` сужено и переименовано в `early_execution_observation`. **CORRECTED далее (pass 5)** — добавлен статус `terminal_unfilled` в enum (см. §12) |
| §9 persistence ordering | 6-шаговый порядок | **accepted unchanged**, детализирован в §11 |
| §10 confirmation | field-accuracy verification | **accepted unchanged**, расширен §26 (fill-before-ack исходы, терминология исходов скорректирована pass 4) |
| §11 storage design | Вариант C, JSONL, без явного fsync | **CORRECTED** — явный fsync-per-append, durable write sequence из 5 шагов, repository write queue отдельно от keyed mutex |
| §12 idempotency (repeat PUT) | no-op для status=applied | **REJECTED** (pass 2) — заменено bounded revalidation с 4 исходами. **Terminal-без-fill ветка REJECTED далее (pass 5):** прежнее "auto-recreate → новая generation → новый create → `entry_package_applied`" было непринятой спорной бизнес-семантикой, введённой ошибочно. **Принято решение B** (из трёх: A-auto-recreate / B-fail closed / C-defer): новый статус `terminal_unfilled`, repeat non-null PUT из этого статуса → `internal_error`, без auto-resurrection; разблокирование только через явный CANCEL (desired_entry=null) → `absent` → обычный новый CREATE |
| §13 history retention | never delete mapping | **accepted unchanged**, теперь embedded (§8) |
| §14 startup/readiness | fail-closed на corrupt store | **accepted unchanged** |
| §15 public API impact | изменений не требуется | correction pass 2 сделал **CORRECTED** ("request-контракт требует delta"); correction pass 3 **REVERTS обратно к accepted unchanged** — изменений публичного контракта не требуется вовсе |
| §16 component ownership | EntryPackageApplicationService выводит triggerDirection | **CORRECTED** — вместо прямой derivation/чтения внешнего поля, вызывает чистый `EntryOrderSemanticsMapper(side)`; добавлены keyed mutex, PositionSizeCalculator, InstrumentTradingRulesProvider, EntryOrderSemanticsMapper |
| §17 scope | добавить triggerDirection derivation в scope A | correction pass 2 сделал **REJECTED** ("это cross-repo prerequisite"); correction pass 3 **REVERTS обратно к ACCEPTED** — `EntryOrderSemanticsMapper` явно входит в scope A как ABI-internal компонент |
| §17 non-scope (ticker→symbol) | (не рассматривалось) | **ADDED — correction pass 4.** Runtime `ticker` → Bybit `symbol` resolution явно вынесена в non-scope как отдельная ABI-wide instrument identity concern; Stage A потребляет уже разрешённый `symbol` как внешнюю зависимость, не проектирует резолвер |
| §19 OpenSpec split | один change | **accepted unchanged** через все correction pass'ы — один change, без prerequisite cross-repo change |
| §21–§27 (async architecture, push/pull, race, ordering, confirmation outcomes, readiness) | — | **accepted unchanged** структурно; §24/§26 терминологически уточнены pass 4 (aggregate observation вместо first-fill facts) |
| §28(a) trigger direction | fail-closed default | pass 2: **ESCALATED** в BLOCKER; pass 3: **RESOLVED**, reversed из BLOCKER — ABI-owned V1 mapping, не unresolved вопрос |
| §28(b) orderLinkId constraints | не проверено | **RESOLVED** (pass 2) |
| §28(d) repeat-PUT trust | доверие рекомендовано | **RESOLVED через REJECTED** (§12, pass 2); terminal-без-fill ветка **уточнена решением B** (pass 5) |
| §28(f) min qty/step source | не определён | **RESOLVED** (pass 2), уточнено pass 4 (resolved `symbol`, не `ticker`) и pass 5 (добавлен `min_notional_value`, полная формула минимума) |
| §28(i) ticker→symbol resolution | (не существовало) | **ADDED, decided non-blocking — correction pass 4.** Реальная ABI-internal dependency (не cross-repo); explicit prerequisite/assumption для proposal/design, не design-level решение внутри этого audit; не блокирует `/opsx:propose` |
| §28(c), (g), (h) | открыты | **accepted unchanged**, явно non-blocking |
| §28(j) terminal_unfilled recovery UX (новое, pass 5) | (не существовало) | **ADDED, decided non-blocking.** Нужен ли отдельный recovery endpoint помимо CANCEL-затем-CREATE — не решается в audit, design-level, не блокирует propose |

### Итоговый статус

```
READY FOR /opsx:propose
```

**Обоснование:**
- trigger semantics для поддерживаемого V1 contour (`ema_pullback`) закрыты — ABI-owned
  deterministic mapping через `EntryOrderSemanticsMapper` (§5/§16), никакой cross-repo
  зависимости; явно запрещён price admission gate — create отправляется без сравнения с
  market price (§5);
- публичные Engine → Runtime → ABI DTO менять не требуется (§15) — `DesiredEntry.side`
  остаётся без изменений, ни request, ни response DTO не расширяются;
- durability boundary закрыта (§11) — явный fsync-per-append durable write sequence;
  сохраняемые данные сужены до агрегированного `early_execution_observation`, individual
  fills/history recovery явно Stage B (§8/§24/§26);
- repeated PUT semantics закрыты (§12) — bounded revalidation с 4 классифицируемыми
  исходами; terminal-без-fill ветка закрыта решением B (fail closed, без auto-recreate,
  разблокирование только через явный CANCEL) — **это был единственный оставшийся
  content-level gap, теперь устранён**;
- sizing/rules boundary закрыта (§6) — `PositionSizeCalculator` port +
  `InstrumentTradingRulesProvider` (min_order_qty, qty_step, **min_notional_value**),
  источник данных подтверждён официально, claim "minimum executable quantity" теперь
  математически обоснован формулой; явно зафиксирована и вынесена в dependency (не
  design) отдельная ticker→symbol resolution concern (§6/§17/§28i);
- identity/generation закрыты (§7) — deterministic hash с generation counter, Bybit
  ограничения подтверждены официально;
- confirmation outcomes закрыты (§10/§26) — пять классифицируемых исходов, включая
  fill-before-acknowledgement, терминология выровнена с сужённой durability-моделью;
- acceptance matrix синхронизирована (§18) — включает identity/concurrency, durability,
  confirmation, repeated PUT (включая terminal_unfilled fail-closed сценарии), sizing
  (включая min_notional_value), readiness boundary, pure mapping, stability, layering,
  V1 scope, price-admission-gate prohibition;
- component ownership непротиворечив (§16) — включая новый `EntryOrderSemanticsMapper`,
  без строк, зависящих от внешнего blocker'а;
- остающиеся вопросы (c, g, h, j) — явно design-level/Stage-B детали; (i) — явная
  ABI-internal dependency, не архитектурное противоречие.

Архитектурных противоречий Stage A не осталось, и оба ранее незакрытых решения (§6
min_notional_value, §12 terminal-без-fill) теперь явно приняты, а не оставлены как
implicit/непроверенные допущения. Единственная новая зависимость (ticker→symbol
resolution, §28i) — не blocker, а explicit prerequisite/assumption, которую proposal
обязан зафиксировать, а не решить внутри своих tasks.

## Authoritative source status (UPDATED — reflects two-input model)

`/opsx:propose abi-entry-package-execution-v1` takes **two** authoritative inputs, each
with a distinct, non-overlapping role:

```
ENTRY_PACKAGE_EXECUTION_AUDIT.md
→ authoritative architecture/execution input

LEGACY_SIGNAL_INTENT_DISPOSITION.md
→ authoritative reuse/retirement input
```

This file no longer claims to be the sole authoritative input on its own — reuse,
forbidden-reuse, and legacy-retirement questions (including the precise scope of any
"переиспользует X" phrasing in §16 above) are governed by
`LEGACY_SIGNAL_INTENT_DISPOSITION.md`, not by this file's shorthand. Отдельного
повторного exploration не требуется для architecture/execution вопросов. Никакой
prerequisite change в `strategy_engine` или `strategy_runtime` не создавался и не
требуется — Engine/Runtime изменений в рамках Stage A не затрагиваются.
