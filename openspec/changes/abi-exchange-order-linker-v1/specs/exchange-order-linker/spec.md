## ADDED Requirements

### Requirement: ABI links exchange orders to trade cycles from its own labels
ABI SHALL run an exchange order linker, owned by the exchange facts module,
when the exchange facts store is `enabled`. It SHALL start after the
correlation store replay succeeded and run every second on its own timer. It
SHALL write a link for an `order_state` fact whose `orderLinkId` is an
`abi-ep-` label produced by `buildEntryPackageOrderLinkId` for a strategy
instance, trade cycle, role (`entry` or `close`) and generation present in the
correlation store, with that instance, cycle, role and generation and evidence
`own_order_link_id_lookup`. The label owner SHALL be found only from the
in-memory correlation records, for every generation from 1 to the record's
current one; ABI SHALL NOT call Bybit for linking.

#### Scenario: Entry order linked
- **WHEN** the stream stores an `order` record with `orderLinkId` equal to the entry label of instance I, cycle C, generation 2
- **THEN** within two seconds `order_links` holds one row for its `orderId` with I, C, role `entry`, generation 2, evidence `own_order_link_id_lookup`

#### Scenario: Close order linked
- **WHEN** the stream stores an `order` record with the close label of instance I, cycle C, generation 1
- **THEN** a link with role `close` and generation 1 is written

#### Scenario: Earlier generation after a replace
- **WHEN** the cycle's record is at generation 3 and a late record of the generation 1 entry order arrives
- **THEN** that order is linked with generation 1

#### Scenario: Closed cycle
- **WHEN** the record of a cycle is `terminal_closed` and a late fill record of its close order arrives
- **THEN** the close order is linked to that cycle

### Requirement: Stop loss and take profit children are linked through their entry
The linker SHALL link an `order_state` fact with an empty `orderLinkId` and a
non-empty `parentOrderLinkId` through the store's child rule: role `stop_loss`
for `stopOrderType` `PartialStopLoss` or `StopLoss`, `take_profit` for
`PartialTakeProfit` or `TakeProfit`, evidence `parent_order_link_id`. Within
one write, entry links SHALL be written before child links.

#### Scenario: Children in the same second as the entry
- **WHEN** the entry record and its `PartialStopLoss` and `PartialTakeProfit` children are stored in the same flush
- **THEN** three links of the same cycle and generation exist after one tick: `entry`, `stop_loss`, `take_profit`

#### Scenario: Child before its entry
- **WHEN** a child record is stored and its entry's record is stored three seconds later
- **THEN** the child is pending first and linked in the tick after the entry is linked

#### Scenario: Unknown child type
- **WHEN** a child record has a `stopOrderType` other than the four above
- **THEN** it is not linked and is counted as `child_type_unknown`

### Requirement: All facts of a linked order belong to its cycle
A link SHALL cover every `order_state` and `execution` fact with the same
`orderId`, so amendments, triggers, fills and cancels need no extra rows.
Facts SHALL NOT be changed by linking.

#### Scenario: Stop moved and filled
- **WHEN** a linked stop loss is amended twice and then filled
- **THEN** its three `order_state` facts and its execution are attributed to the cycle through `order_id`, and `order_links` still has one row for it

### Requirement: Records that are not ABI trading orders stay unattributed
The linker SHALL NOT link an order whose `orderLinkId` is non-empty without the
`abi-ep-` prefix (`foreign_label`), or whose `orderLinkId` and
`parentOrderLinkId` are both empty (`no_label`). Executions without
`orderId` and account snapshots SHALL NOT be linked. Unattributed orders SHALL
be counted by reason.

#### Scenario: Account-wide close-all
- **WHEN** the account close-all action creates a market order without `orderLinkId`
- **THEN** it is not linked and `unattributedOrders.no_label` grows by one

#### Scenario: Funding
- **WHEN** an execution with `execType` `Funding` and no `orderId` is stored
- **THEN** no link is written

### Requirement: Pending links are retried, then given up
An order that cannot be linked yet (`own_label_unknown`, `parent_not_found`)
SHALL be retried every second for 10 minutes and then counted as
unattributed with that reason. At startup the linker SHALL read all facts from
the beginning and skip orders that already have a link, so every unlinked
order is retried after a restart. `parent_ambiguous` and `link_conflict` SHALL
be final within a run.

#### Scenario: Restart
- **WHEN** ABI restarts with 50 linked and 3 unattributed orders in the database
- **THEN** no linked order is written again, the 3 orders are classified again, and no error is raised

#### Scenario: Give up
- **WHEN** a child's entry never appears for 10 minutes
- **THEN** the child is counted as `parent_not_found` and no longer retried in this run

### Requirement: Linker isolated from trading
The linker SHALL NOT be called or awaited by any trading route or service. It
SHALL only read correlation records through a read-only listing, never take
the per-pair lock, never save a correlation record and never call Bybit. Every
linker failure SHALL be caught inside the linker, emitted without record
payloads and shown in health; it SHALL NOT throw into the HTTP server or exit
the process. One tick SHALL handle at most 1000 facts. A write refused for one
order (`link_conflict`) SHALL NOT prevent the other orders of the tick from
being linked.

#### Scenario: Database write fails
- **WHEN** writing links throws an I/O error
- **THEN** the entry package, open-position, position management and recovery routes answer as before, `/health.exchangeLinker.lastError` is set, and the next tick retries

#### Scenario: Conflicting link
- **WHEN** an order is already linked to cycle A and the index now names cycle B
- **THEN** the link to A stays, the order is counted as `link_conflict`, an `exchange_order_linker_link_conflict` event is emitted, and the other orders of the tick are linked

#### Scenario: Store not enabled
- **WHEN** the store is `disabled` or `unavailable`
- **THEN** the linker is not started and ABI behaves exactly as before this change
