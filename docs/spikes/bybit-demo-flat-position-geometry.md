# Bybit Demo flat position geometry evidence

Date: 2026-08-29  
Environment: Bybit Demo, authenticated read-only `GET /v5/position/list`  
Mutation policy: no order create, no position-mode switch, no account mutation

## Observed evidence

The available Demo account was queried by exact linear symbol for `BTCUSDT`, `ETHUSDT`,
`SOLUSDT`, `XRPUSDT`, and `DOGEUSDT`. Every queried symbol was configured in one-way mode.
Each response contained exactly one flat row with:

- `result.category = "linear"`;
- the requested `symbol`;
- `positionIdx = 0`;
- `side = ""`;
- `size = "0"`;
- `openTime = 0` or omitted on one observed flat row;
- empty or zero-form `avgPrice`, plus empty stop-loss and take-profit fields.

The response for `BTCUSDT` had one row and reported `avgPrice = "0"`, `openTime = 0`,
`stopLoss = ""`, and no `takeProfit` key. Sensitive credentials and unrelated account fields are
not retained in repository evidence.

## Hedge evidence status

No queried symbol was already operator-configured for Hedge Mode. Because this change expressly
forbids ABI from calling the switch-mode endpoint, the required flat Hedge Mode cardinality and
omission evidence could not be captured from this account.

Consequently the hedge position decoder does not infer flatness from a missing target row. It
accepts a target hedge slot only when that exact `positionIdx` row is present, rejects duplicate
slot rows, and treats every unproven target-row omission as inconclusive. A deterministic flat
hedge contract fixture must be added only after an operator supplies an isolated Demo symbol that
is already in Hedge Mode.
