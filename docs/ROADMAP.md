# Roadmap

The next development milestones are:

1. **Fill watcher** — detect when an entry order fills and update the journal and intent state reliably.
2. **Protection after fill** — place the planned stop-loss and take-profit orders after a confirmed fill, with idempotency and recovery for partial failures.
3. **Risk-based position sizing** — replace the fixed `0.001` smoke quantity with sizing derived from the configured risk budget and stop distance.
4. **Operator endpoints and UI** — complete the operational surface for inspecting intents, orders, positions, failures, and guarded emergency actions.
5. **Docker and CI** — add a reproducible container build and automated typecheck, test, and build pipelines.

Mainnet live execution remains out of scope until fill handling, protection placement, sizing, and operational safeguards are complete.
