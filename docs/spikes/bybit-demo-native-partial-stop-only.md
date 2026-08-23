# Bybit Demo spike: native Partial stop-only semantics

Дата эксперимента: 2026-08-18.

## Цель и границы

Проверить, можно ли безопасно и с сохранением attribution преобразовать уже materialized native Bybit Partial TP/SL pair в состояние `STOP active + TAKE absent`, соответствующее `PUT /protection` с `take_price = null`.

Эксперимент выполнялся только на Bybit Demo. Production code, OpenSpec и master plan не изменялись. Mainnet, account-wide cleanup, generic ABI stop orders и cancel/recreate fallback не использовались.

## 1. Repository и environment

- Branch: `claude/multi-spec-architecture-plan-jgayoi`
- HEAD на момент spike: `249f7ce6ff52037b4bc00aed7eb0c65d41b627c0`
- Endpoint: `https://api-demo.bybit.com`
- Canonical local secret source: `/Users/mcroma/BBB_secrets/abi/bybit-demo.env`
- Instrument: linear USDT perpetual `ETHUSDT`
- `tickSize`: `0.01`
- `qtyStep`: `0.01`
- Experimental quantity: `0.10 ETH`, около `191 USDT`
- Перед началом на symbol не было чужих positions или live orders.

Значения credentials, signatures и signed headers не сохранялись и не выводились.

## 2. Experiment A: cancel exact TAKE child

### Setup

Создан один conditional Market Buy parent с attached native Partial TP/SL:

```json
{
  "symbol": "ETHUSDT",
  "side": "Buy",
  "orderType": "Market",
  "qty": "0.10",
  "triggerPrice": "1914.62",
  "triggerDirection": 1,
  "triggerBy": "LastPrice",
  "orderLinkId": "abi-stoponly-a-msyvex7b00f6ce",
  "takeProfit": "2010.35",
  "stopLoss": "1818.87",
  "tpslMode": "Partial",
  "tpOrderType": "Market",
  "slOrderType": "Market"
}
```

- Parent `orderId`: `eaedcef7-c314-43c5-ab16-c3aa5a2750d6`
- Actual position average price: `1914.61`
- Filled quantity: `0.10`

### Snapshot A: materialized children before cancel

Обе legs были active, имели одинаковую quantity и однозначно относились к parent через `parentOrderLinkId`.

```json
[
  {
    "orderId": "835af22e-f58b-425e-ab7f-6db3ffd4821b",
    "orderLinkId": "",
    "parentOrderLinkId": "abi-stoponly-a-msyvex7b00f6ce",
    "stopOrderType": "PartialStopLoss",
    "createType": "CreateByPartialStopLoss",
    "qty": ".1",
    "leavesQty": ".1",
    "triggerPrice": "1818.87",
    "orderStatus": "Untriggered",
    "tpslMode": "Partial"
  },
  {
    "orderId": "72df0999-66db-4fc0-9520-49fd204deee5",
    "orderLinkId": "",
    "parentOrderLinkId": "abi-stoponly-a-msyvex7b00f6ce",
    "stopOrderType": "PartialTakeProfit",
    "createType": "CreateByPartialTakeProfit",
    "qty": ".1",
    "leavesQty": ".1",
    "triggerPrice": "2010.35",
    "orderStatus": "Untriggered",
    "tpslMode": "Partial"
  }
]
```

Change 6 classifier: `attributed`.

### Exact TAKE cancellation

В `/v5/order/cancel` был передан symbol и exact TAKE `orderId`. Exchange ACK:

```json
{
  "retCode": 0,
  "retMsg": "OK",
  "result": {
    "orderId": "72df0999-66db-4fc0-9520-49fd204deee5",
    "orderLinkId": ""
  }
}
```

Fresh realtime/history observations:

- Сразу после ACK обе legs исчезли из realtime; classifier для active set стал `none`.
- Через 2.5 секунды history показал обе legs со статусом `Deactivated`.
- STOP не остался active.
- Исходные `orderId`, quantities, roles и `parentOrderLinkId` сохранились в terminal records.
- У обеих legs был одинаковый `updatedTime`: `1787070134716`.
- Новых children и duplicate roles не появилось.
- Status-agnostic Change 6 classifier для history-set остаётся `attributed`, хотя active protection уже отсутствует.

Sanitised terminal evidence:

```json
[
  {
    "orderId": "835af22e-f58b-425e-ab7f-6db3ffd4821b",
    "parentOrderLinkId": "abi-stoponly-a-msyvex7b00f6ce",
    "stopOrderType": "PartialStopLoss",
    "qty": ".1",
    "orderStatus": "Deactivated",
    "updatedTime": "1787070134716"
  },
  {
    "orderId": "72df0999-66db-4fc0-9520-49fd204deee5",
    "parentOrderLinkId": "abi-stoponly-a-msyvex7b00f6ce",
    "stopOrderType": "PartialTakeProfit",
    "qty": ".1",
    "orderStatus": "Deactivated",
    "updatedTime": "1787070134716"
  }
]
```

**Фактическая семантика:** cancel exact TAKE child деактивирует всю native attached Partial pair.

## 3. Experiment B: direct child amend removal semantics

После cleanup Experiment A создан отдельный parent:

- Parent `orderLinkId`: `abi-stoponly-b-msyvf9rp1b1ec2`
- Parent `orderId`: `59454ce2-a342-4689-82ec-48f28875eb26`
- Side/qty: `Buy 0.10 ETH`
- Trigger: `1914.33`, затем актуализирован до `1914.32`
- TP: `2010.04`
- SL: `1818.60`
- TAKE child: `8b1c4ea2-3465-489e-8ae7-fb2641d77aa9`
- STOP child: `86986d9c-b08a-4cb5-8d95-3019c5a16c93`

На exact TAKE child выполнен `/v5/order/amend` с документированной unset-семантикой `takeProfit: "0"`:

```json
{
  "request": {
    "category": "linear",
    "symbol": "ETHUSDT",
    "orderId": "8b1c4ea2-3465-489e-8ae7-fb2641d77aa9",
    "takeProfit": "0"
  },
  "response": {
    "retCode": 0,
    "retMsg": "OK",
    "result": {
      "orderId": "8b1c4ea2-3465-489e-8ae7-fb2641d77aa9",
      "orderLinkId": ""
    }
  }
}
```

REST ACK не был принят за доказательство. Fresh read-back в течение 2.5 секунд показал:

- TAKE остался `Untriggered`, qty `.1`, triggerPrice `2010.04`.
- STOP остался `Untriggered`, qty `.1`, triggerPrice `1818.60`.
- `orderId`, roles и parent attribution обеих legs сохранились.
- Новых children и duplicates не появилось.
- Изменился только `updatedTime` TAKE.
- Change 6 classifier: `attributed`.

Следовательно, `takeProfit: "0"` в direct amend materialized TAKE child является наблюдаемым no-op для удаления этой leg. Недокументированные `triggerPrice: "0"`, `qty: "0"` и прочие magic values не проверялись.

## 4. Experiment C: position trading-stop Partial

После exact neutralization второй attached pair позиция оставлена открытой и выполнен `/v5/position/trading-stop`:

```json
{
  "request": {
    "category": "linear",
    "symbol": "ETHUSDT",
    "tpslMode": "Partial",
    "positionIdx": 0,
    "takeProfit": "0",
    "stopLoss": "1799.46",
    "tpSize": "0.10",
    "slSize": "0.10",
    "tpOrderType": "Market",
    "slOrderType": "Market",
    "slTriggerBy": "LastPrice"
  },
  "response": {
    "retCode": 0,
    "retMsg": "OK",
    "result": {}
  }
}
```

Fresh realtime read-back показал ровно один active native Partial STOP и отсутствие TAKE:

```json
{
  "orderId": "681144d4-ed31-47a0-9684-c64f01a9f1f4",
  "orderLinkId": "",
  "parentOrderLinkId": "",
  "orderStatus": "Untriggered",
  "side": "Sell",
  "qty": ".1",
  "leavesQty": ".1",
  "triggerPrice": "1799.46",
  "triggerDirection": 2,
  "triggerBy": "LastPrice",
  "stopOrderType": "PartialStopLoss",
  "createType": "CreateByPartialStopLoss",
  "tpslMode": "Partial",
  "reduceOnly": true,
  "closeOnTrigger": true
}
```

Это доказывает, что Bybit native Partial физически может представить position-scoped stop-only state. Однако созданный STOP имеет пустой `parentOrderLinkId` и не attributable к конкретному entry. Для parent второго experiment Change 6 classifier active-set возвращает `none`; новый STOP не может стать его own attached protection по текущим правилам.

## 5. Verdict

`NATIVE_PARTIAL_STOP_ONLY_PARTIALLY_SUPPORTED`

- Attached entry-attributed Partial pair нельзя преобразовать в stop-only через exact TAKE cancel: exchange деактивирует sibling STOP.
- Direct child amend с `takeProfit: "0"` не удаляет TAKE.
- Position-scoped `/v5/position/trading-stop` с `tpslMode: "Partial"` и `takeProfit: "0"` создаёт native stop-only state.
- Этот stop-only child не сохраняет entry attribution: `parentOrderLinkId == ""`.
- Следовательно, native Partial не предоставляет доказанный способ получить одновременно `STOP active + TAKE absent` и сохранить Change 6 parent ownership.

## 6. Implications for Change 7

Для `take_price = null` Change 7 должен fail closed до destructive exchange writes, пока ownership model остаётся parent-scoped:

- не cancel TAKE child, поскольку это снимает STOP;
- не считать direct child amend с `takeProfit: "0"` удалением;
- не подменять операцию position-scoped `trading-stop`, поскольку результат становится unattributed;
- не вводить generic ABI stop order в рамках этого change.

Proposal/master plan требуют следующих corrections перед implementation:

1. Native attached Partial legs cancel-coupled на уровне pair.
2. Поддержка direct amend price/qty не означает поддержку leg removal.
3. `takeProfit: "0"` в child amend не materializes desired stop-only state.
4. Native stop-only достижим только через position-level trading-stop в проверенном сценарии и не несёт parent attribution.
5. `attributed` от status-agnostic classifier не доказывает active coverage: terminal pair также классифицируется как attributed.
6. Переход pair → cancel TAKE нельзя использовать как реализацию `take_price = null`.

## 7. Pair/classifier observations

- До cancel: active STOP + TAKE → `attributed`.
- Сразу после pair deactivation: active set пуст → `none`.
- В history terminal STOP + TAKE сохраняют attribution → status-agnostic `attributed`.
- Position-scoped stop-only child имеет пустой `parentOrderLinkId` → для исходного parent `none`.
- Duplicate protection ни в одном эксперименте не наблюдалась.

## 8. Cleanup

Cleanup выполнялся только по exact experimental identities, без cancel-all:

- Experiment A exposure закрыта exact reduce-only Market order `d7c25d08-ef81-432e-aada-a391905e3d54`.
- Experiment B attached pair нейтрализована exact child cancellation; sibling cancellation после coupling вернула expected `110001` (order already absent).
- Experiment C stop-only child `681144d4-ed31-47a0-9684-c64f01a9f1f4` отменён exact orderId.
- Experiment B/C exposure закрыта exact reduce-only Market order `a14d708b-0e50-4052-a08b-21d45714b765`.
- Final nonzero experimental positions: `[]`.
- Final live experimental orders: `[]`.
- Temporary script вне repository удалён.

## 9. API contract references

- [Cancel Order](https://bybit-exchange.github.io/docs/v5/order/cancel-order)
- [Amend Order](https://bybit-exchange.github.io/docs/v5/order/amend-order)
- [Set Trading Stop](https://bybit-exchange.github.io/docs/v5/position/trading-stop)
