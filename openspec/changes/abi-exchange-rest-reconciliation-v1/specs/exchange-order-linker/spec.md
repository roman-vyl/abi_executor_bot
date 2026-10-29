## MODIFIED Requirements

### Requirement: Records that are not ABI trading orders are not linked
The linker SHALL NOT link an order whose `orderLinkId` is non-empty without the
`abi-ep-` prefix (`foreign_label`), or whose `orderLinkId` and
`parentOrderLinkId` are both empty (`no_label`). Executions without
`orderId` and account snapshots SHALL NOT be linked. Such orders SHALL
be counted by reason as not linkable. An `order_state` fact with `source`
`rest` and both labels empty SHALL NOT decide an order: the order stays
unclassified until a WS fact or a labelled REST fact of it is stored, because
Bybit REST order history carries no `parentOrderLinkId`.

#### Scenario: Account-wide close-all
- **WHEN** the account close-all action creates a market order without `orderLinkId`
- **THEN** it is not linked and `notLinkableOrders.no_label` grows by one

#### Scenario: Funding
- **WHEN** an execution with `execType` `Funding` and no `orderId` is stored
- **THEN** no link is written

#### Scenario: Child first seen by REST
- **WHEN** a stop loss child is stored from REST without labels and later from WS with `parentOrderLinkId`
- **THEN** it is linked as `stop_loss` once its entry is linked, and it is never counted as `no_label`
