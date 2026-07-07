# Abi Agent Context

Communication:
- Always communicate with the user in Russian.

Abi is a TypeScript Node execution service for bbb research signals.

Current state:
- Bybit demo read-only smoke works.
- Bybit demo write smoke works: create stop-market entry, query by orderLinkId, cancel.
- No active BTCUSDT orders after smoke.
- No open BTCUSDT position after smoke.
- Tests pass: npm test, 16 tests.

Architecture:
- src/app: HTTP server and app entrypoint
- src/config: env config
- src/domain: signal/intent/execution plan/order identity
- src/risk: risk guard and position sizing
- src/execution: live guard and guarded Bybit execution
- src/journal: event journal
- src/exchange: Bybit adapter and mapper
- src/routes: thin HTTP routes
- src/services/intents: use-case logic
- test: unit tests, fakes, fixtures

Important contract:
bbb sends:
- signal_id
- instance_id
- strategy_id
- symbol
- side
- entry.type stop_market
- entry.trigger_price
- entry.trigger_direction rises_to/falls_to
- stop_loss.trigger_price
- take_profit.trigger_price

Abi owns:
- position sizing, currently fixed ABI_FIXED_SMOKE_QTY=0.001
- orderLinkId generation from instance_id
- Bybit execution
- journal and intent status

Known bug to fix next:
If POST /signals reaches Bybit create order and Bybit rejects the create call, Abi has already journaled the intent as planned. That leaves instance_id active and future attempts with same instance_id return 409 active_intent_exists.

Desired fix:
- Add failed intent status, e.g. failed_to_create_entry.
- On Bybit create failure, append intent_status_changed with failed status.
- findActiveIntentByInstanceId must treat only planned status as active.
- Failed status must not block future signals with same instance_id.
- Preserve dry-run and successful live behavior.
- Add focused unit tests.
- Run npm test.
