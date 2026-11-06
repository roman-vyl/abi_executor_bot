## Purpose

Define a bounded, optional verification of already stored executions that proves the exact earliest fill of the current entry identity without replacing exchange-state resolution.

## ADDED Requirements

### Requirement: SQLite proof requires an already terminal entry order
Before any local fact/link read, ABI SHALL require an authoritative own-order proof of the current entry's terminal exchange status and positive final cumExecQty from the same consistent observation. Only existing supported terminal statuses (Filled or a supported final status with a proven positive fill) qualify. A live PartiallyFilled order, unknown terminality or a correlation lifecycle status alone SHALL NOT qualify. ABI SHALL NOT derive eligibility from SQLite or issue new exchange queries for it. An existing final observation may be reused only under its existing validity rules.

#### Scenario: A later fill replaces a missing earlier fill in a live-order sample
- **WHEN** a live entry was confirmed at cumExecQty=2, its early execution of 2 is missing locally and a later execution of 2 arrives before fallback
- **THEN** ABI SHALL reject SQLite eligibility without reading facts/links, even if a local sum would equal 2, and retain the unsuccessful REST capture's existing semantics

#### Scenario: Multiple executions of a terminal entry
- **WHEN** an entry is already proven Filled or another supported terminal status with positive final cumExecQty
- **THEN** all identity, unique-quantity completeness and earliest-time checks SHALL still be required before using its stored executions

#### Scenario: Terminal entry cancelled after a partial fill
- **WHEN** the remaining quantity was cancelled and the existing proof establishes terminal status and positive final executed quantity
- **THEN** completeness SHALL be tested against that final cumExecQty, not the larger original order quantity

### Requirement: Local evidence is accepted only with exact identity and complete unique quantity
For an entry eligible under the terminal-order requirement, ABI SHALL verify current entry orderId/orderLinkId, category, symbol, side, instance, cycle, generation and role using the authoritative own-order proof and matching store link. ABI SHALL reject inconsistent execution rows, deduplicate matching Trade executions by execId, sum their positive quantities with exact decimal arithmetic and require equality with the positive confirmed own-order cumExecQty. Only then SHALL min(valid execTime) be accepted; receipt/write times SHALL NOT be used.

#### Scenario: One complete execution supplies the true timestamp
- **WHEN** a proven terminal entry has one unique correctly linked Trade execution that covers the entire confirmed fill
- **THEN** its execTime is verified after the unsuccessful execution-list REST capture

#### Scenario: Several partial executions are complete and out of order
- **WHEN** a proven terminal entry has several matching unique executions that arrive out of time order and their exact summed quantities equal confirmed cumExecQty
- **THEN** ABI verifies their minimum execTime, independent of arrival order

#### Scenario: Duplicate and conflicting execIds
- **WHEN** the same execId occurs in matching WS and REST records
- **THEN** it contributes once; any conflicting identity, quantity or timestamp makes the local result unavailable

#### Scenario: A missing earlier partial execution
- **WHEN** the local quantity is less than confirmed cumExecQty
- **THEN** ABI SHALL NOT accept its minimum timestamp and SHALL retain the original REST failure semantics

#### Scenario: Overcount or wrong owner
- **WHEN** quantities exceed the proof or an order, symbol, side, role, cycle or generation conflicts
- **THEN** local evidence SHALL NOT provide first_fill, even if a subset would match

### Requirement: Local verification is bounded and optional
ABI SHALL accept no truncated local read as complete. A read reaching its limit, unavailable/disabled store, missing identity/link, malformed evidence or read failure SHALL yield an unavailable local result after the already-attempted REST capture. ABI SHALL NOT turn SQLite availability into an admission/readiness dependency or alter its schema.

#### Scenario: Read limit reached despite an apparently sufficient prefix
- **WHEN** readFactsForOrder returns its full configured limit
- **THEN** ABI treats the local set as unproven and falls back, even if the visible sum equals confirmed quantity

#### Scenario: Store unavailable or ambiguous
- **WHEN** SQLite is disabled, throws or cannot prove identity/completeness
- **THEN** the already-obtained REST failure retains its existing branch-specific semantics

### Requirement: One verifier is used without changing cycle truth or persistence rules
ABI SHALL reuse the same local proof rules for open-position and both recovery capture branches, after their existing truth determination and only after the existing REST capture cannot establish a timestamp. Saved first_fill SHALL remain immutable. Existing mutex, generation continuity, closure priority and persistence-error semantics SHALL remain unchanged. No execution fact alone SHALL reopen a closed cycle or authorize an exchange write.

#### Scenario: Cycle closes before lookup
- **WHEN** existing lookup proves closure despite stored entry executions
- **THEN** ABI preserves the closed/terminal response, not position_open=true

#### Scenario: Generation changes or timestamp is already captured
- **WHEN** the pair changes generation before the locked capture or already has a captured timestamp
- **THEN** old-generation facts SHALL NOT be used and an existing timestamp SHALL NOT be overwritten

#### Scenario: No local proof and empty REST
- **WHEN** neither source establishes a usable time
- **THEN** existing branch-specific failure/best-effort behavior remains unchanged, without a fabricated timestamp

### Requirement: Successful REST capture never reads SQLite
ABI SHALL use saved first_fill, otherwise the existing REST capture, and only on its failure and with terminal-entry eligibility attempt verified local facts. Successful REST capture SHALL NOT perform any SQLite fact or link read. This source order SHALL NOT bypass initial exchange-state or closure checks and SHALL NOT add new exchange writes or a second REST capture after the local attempt.

#### Scenario: Saved timestamp or successful REST
- **WHEN** a timestamp is already saved or the initial REST capture finds it
- **THEN** ABI SHALL return through its existing path without any SQLite verification read

#### Scenario: REST unavailable and SQLite cannot prove a value
- **WHEN** the initial REST capture fails and the bounded SQLite attempt is unavailable
- **THEN** ABI preserves the original branch-specific failure/best-effort behavior without looping through REST again

### Requirement: Synchronous-read latency is reviewed before deployment
Before deploying this change, the team SHALL measure address-scoped bounded reads and verifier latency on representative working-volume data under concurrent WS batch writes, on equivalent Mac Docker Desktop storage. The report SHALL include sample counts, p50/p95/p99/max read durations, event-loop lag, WS processing/flush latency, drops, backlog and a no-fallback baseline. Exceptions handling SHALL NOT be represented as a time bound for a synchronous query.

#### Scenario: Functional tests pass but latency is unreviewed
- **WHEN** functional tests pass but the representative latency and WS-impact measurements are absent or unaccepted
- **THEN** the change SHALL NOT be deployed until those results are separately reviewed
