# Roadmap

The next development milestones are:

1. **protection-verification-and-repair-v1** — add bounded query/retry after create or amend acknowledgement, verify pending-order protection, watch fills and position protection, repair missing protection through `/v5/position/trading-stop`, and perform an emergency market close when a position exists after the intended stop has already been breached.
2. **Risk-based position sizing** — replace the fixed `0.001` smoke quantity with sizing derived from the configured risk budget and stop distance.
3. **Operator endpoints and UI** — complete the operational surface for inspecting intents, orders, positions, failures, protection state, and guarded emergency actions.
4. **Docker and CI** — add a reproducible container build and automated typecheck, test, and build pipelines.

Mainnet live execution remains out of scope until protection verification and repair, sizing, and operational safeguards are complete.
