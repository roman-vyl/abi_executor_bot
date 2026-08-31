# Bybit Demo flat position geometry evidence

Date: 2026-08-30

Environment: Bybit Demo (`https://api-demo.bybit.com`)

Credentials: Demo API credentials only; no credential values retained

Symbol: isolated linear USDT perpetual `ZROUSDT`

Order/position policy: no orders created, no positions opened, no account-wide mode mutation

## Safety preflight

Before the mode change, authenticated symbol-scoped reads established:

- `GET /v5/position/list?category=linear&symbol=ZROUSDT`: one row with
  `positionIdx = 0`, `side = ""`, and `size = "0"`;
- `GET /v5/order/realtime?category=linear&symbol=ZROUSDT&openOnly=0&limit=50`:
  `retCode = 0` and zero active orders.

This proved that the selected symbol had no position and no active orders. No order endpoint with a
write operation was called at any point.

## One-time operational symbol mode switch

The operator workflow, outside ABI production code, sent exactly one Demo API request for this
symbol only:

```json
{
  "method": "POST",
  "baseUrl": "https://api-demo.bybit.com",
  "path": "/v5/position/switch-mode",
  "body": {
    "category": "linear",
    "symbol": "ZROUSDT",
    "mode": 3
  }
}
```

Exact response:

```json
{
  "httpStatus": 200,
  "body": {
    "retCode": 0,
    "retMsg": "OK",
    "result": {},
    "retExtInfo": {},
    "time": 1788072377454
  }
}
```

`mode = 3` is the requested symbol-scoped Both Sides Mode. ABI production code was not given a
switch-mode method or automatic mode-management behavior.

## Authenticated flat Hedge Mode observation

Immediately after the successful switch, the operator workflow sent authenticated read-only
`GET /v5/position/list?category=linear&symbol=ZROUSDT`.

Exact raw response body:

```json
{
  "retCode": 0,
  "retMsg": "OK",
  "result": {
    "nextPageCursor": "ZROUSDT%2C1788072377454%2C2",
    "category": "linear",
    "list": [
      {
        "symbol": "ZROUSDT",
        "leverage": "10",
        "breakEvenPrice": "",
        "autoAddMargin": 0,
        "avgPrice": "0",
        "liqPrice": "",
        "riskLimitValue": "10000",
        "takeProfit": "",
        "positionValue": "",
        "isReduceOnly": false,
        "positionIMByMp": "",
        "tpslMode": "Full",
        "riskId": 1,
        "trailingStop": "0",
        "unrealisedPnl": "",
        "markPrice": "1.08",
        "adlRankIndicator": 0,
        "cumRealisedPnl": "0",
        "positionMM": "",
        "createdTime": "1788072377454",
        "positionIdx": 1,
        "openTime": 0,
        "positionIM": "",
        "positionMMByMp": "",
        "seq": -1,
        "updatedTime": "1788072377454",
        "side": "",
        "bustPrice": "",
        "positionBalance": "0",
        "leverageSysUpdatedTime": "",
        "curRealisedPnl": "0",
        "size": "0",
        "positionStatus": "Normal",
        "mmrSysUpdatedTime": "",
        "stopLoss": "",
        "tradeMode": 0,
        "sessionAvgPrice": ""
      },
      {
        "symbol": "ZROUSDT",
        "leverage": "10",
        "breakEvenPrice": "",
        "autoAddMargin": 0,
        "avgPrice": "0",
        "liqPrice": "",
        "riskLimitValue": "10000",
        "takeProfit": "",
        "positionValue": "",
        "isReduceOnly": false,
        "positionIMByMp": "",
        "tpslMode": "Full",
        "riskId": 1,
        "trailingStop": "0",
        "unrealisedPnl": "",
        "markPrice": "1.08",
        "adlRankIndicator": 0,
        "cumRealisedPnl": "0",
        "positionMM": "",
        "createdTime": "1788072377454",
        "positionIdx": 2,
        "openTime": 0,
        "positionIM": "",
        "positionMMByMp": "",
        "seq": -1,
        "updatedTime": "1788072377454",
        "side": "",
        "bustPrice": "",
        "positionBalance": "0",
        "leverageSysUpdatedTime": "",
        "curRealisedPnl": "0",
        "size": "0",
        "positionStatus": "Normal",
        "mmrSysUpdatedTime": "",
        "stopLoss": "",
        "tradeMode": 0,
        "sessionAvgPrice": ""
      }
    ]
  },
  "retExtInfo": {},
  "time": 1788072378809
}
```

Observed response geometry:

- cardinality: exactly 2 rows;
- separate long and short slot rows are both present;
- first row: `positionIdx = 1`, `side = ""`, `size = "0"`, `avgPrice = "0"`,
  `openTime = 0`, `stopLoss = ""`, `takeProfit = ""`;
- second row: `positionIdx = 2`, `side = ""`, `size = "0"`, `avgPrice = "0"`,
  `openTime = 0`, `stopLoss = ""`, `takeProfit = ""`;
- no `positionIdx = 0` row is present.

The deterministic full-response fixture is
`test/fixtures/bybit-demo-flat-hedge-position-list.json`.

## Proven decoder contract

The flat hedge decoder now admits only the observed geometry: a symbol-scoped linear response with
exactly one slot-1 row and one slot-2 row, both canonical flat rows with the observed empty/default
fields above. Either expected direction resolves to `no_position` from that complete geometry.

The following remain fail-closed because they were not proven by this observation:

- empty list or a single directional row;
- a missing target or opposite slot row;
- `positionIdx = 0`, an unexpected index, or duplicate indexes in hedge decoding;
- a zero-size directional row with non-observed `side`, `avgPrice`, `openTime`, `stopLoss`, or
  `takeProfit` geometry;
- a flat target row combined with a live opposite row;
- malformed envelopes/items, category or symbol mismatch, and invalid sizes.

The strict one-way single-row branch remains unchanged. Existing positive-size controlled hedge
decoding remains target-slot-specific and never borrows the opposite slot's values.
