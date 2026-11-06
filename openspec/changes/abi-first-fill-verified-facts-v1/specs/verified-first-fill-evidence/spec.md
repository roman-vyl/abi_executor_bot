## Purpose

Define a bounded, optional verification of already stored executions that proves the exact earliest fill of the current entry identity without replacing exchange-state resolution.

## ADDED Requirements

### Requirement: Local evidence is accepted only with exact identity and complete unique quantity
ABI SHALL verify current entry orderId/orderLinkId, category, symbol, side, instance, cycle, generation and role using the authoritative own-order proof and matching store link. ABI SHALL reject inconsistent execution rows, deduplicate matching Trade executions by execId, sum their positive quantities with exact decimal arithmetic and require equality with the positive confirmed own-order cumExecQty. Only then SHALL min(valid execTime) be accepted; receipt/write times SHALL NOT be used.

#### Scenario: One complete execution supplies the true timestamp
- **WHEN** one unique correctly linked Trade execution covers the entire confirmed fill
- **THEN** its execTime is verified without an execution-list REST request

#### Scenario: Several partial executions are complete and out of order
- **WHEN** several matching unique executions arrive out of time order and their exact summed quantities equal confirmed cumExecQty
- **THEN** ABI verifies their minimum execTime, independent of arrival order

#### Scenario: Duplicate and conflicting execIds
- **WHEN** the same execId occurs in matching WS and REST records
- **THEN** it contributes once; any conflicting identity, quantity or timestamp makes the local result unavailable

#### Scenario: A missing earlier partial execution
- **WHEN** the local quantity is less than confirmed cumExecQty
- **THEN** ABI SHALL NOT accept its minimum timestamp and SHALL use the existing REST fallback

#### Scenario: Overcount or wrong owner
- **WHEN** quantities exceed the proof or an order, symbol, side, role, cycle or generation conflicts
- **THEN** local evidence SHALL NOT provide first_fill, even if a subset would match

### Requirement: Local verification is bounded and optional
ABI SHALL accept no truncated local read as complete. A read reaching its limit, unavailable/disabled store, missing identity/link, malformed evidence or read failure SHALL yield an unavailable local result and the existing REST fallback. ABI SHALL NOT turn SQLite availability into an admission/readiness dependency or alter its schema.

#### Scenario: Read limit reached despite an apparently sufficient prefix
- **WHEN** readFactsForOrder returns its full configured limit
- **THEN** ABI treats the local set as unproven and falls back, even if the visible sum equals confirmed quantity

#### Scenario: Store unavailable or ambiguous
- **WHEN** SQLite is disabled, throws or cannot prove identity/completeness
- **THEN** existing REST capture remains available and successful REST proof is handled as before

### Requirement: One verifier is used without changing cycle truth or persistence rules
ABI SHALL reuse the same local proof rules for open-position and both recovery capture branches, after their existing truth determination and before REST capture. Saved first_fill SHALL remain immutable. Existing mutex, generation continuity, closure priority and persistence-error semantics SHALL remain unchanged. No execution fact alone SHALL reopen a closed cycle or authorize an exchange write.

#### Scenario: Cycle closes before lookup
- **WHEN** existing lookup proves closure despite stored entry executions
- **THEN** ABI preserves the closed/terminal response, not position_open=true

#### Scenario: Generation changes or timestamp is already captured
- **WHEN** the pair changes generation before the locked capture or already has a captured timestamp
- **THEN** old-generation facts SHALL NOT be used and an existing timestamp SHALL NOT be overwritten

#### Scenario: No local proof and empty REST
- **WHEN** neither source establishes a usable time
- **THEN** existing branch-specific failure/best-effort behavior remains unchanged, without a fabricated timestamp
