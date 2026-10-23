## ADDED Requirements

### Requirement: Historical attribution reads the cycle's whole lifetime, not one page
ABI SHALL resolve a cycle's own attached protection from the Bybit order history of the symbol over the cycle's lifetime: from the cycle's first-fill time (the entry creation time when no first-fill time is stored), less a safety margin, to the present, in request windows of at most 7 days, following the response cursor inside each window until it is empty. ABI SHALL NOT limit the history read to a single page of 50 rows.

#### Scenario: Closing stop pushed off the first page by later orders
- **WHEN** a cycle's own stop is `Filled` and more than 50 later orders of the same symbol exist in history
- **THEN** ABI continues through the cursor and attributes the stop by its `parentOrderLinkId`
- **AND** the existing completion proof receives that leg

#### Scenario: Cycle older than one request window
- **WHEN** the cycle started more than 7 days ago
- **THEN** ABI reads each 7-day window from the cycle start to now
- **AND** a window never spans more than 7 days

#### Scenario: Both own legs found early
- **WHEN** both own legs are attributed after a page
- **THEN** ABI may stop reading further pages and windows
- **AND** the existing classification and completion proof run on those two legs

#### Scenario: One leg found never ends the read early
- **WHEN** only one own leg, or none, has been attributed
- **THEN** ABI continues to the end of the cycle's lifetime window
- **AND** a result that relies on the history being complete is produced only after that full pass

### Requirement: An incomplete history read is never reported as an absent or partial result
ABI SHALL report `ambiguous` with reason `query_failed` when the history read hits its page or window cap, a page fails or cannot be decoded, or the cursor does not advance. ABI SHALL NOT report `none` or a pair shape computed from a partially read history.

#### Scenario: Page cap reached
- **WHEN** the history read reaches its page cap before the cursor is empty
- **THEN** the resolution is `ambiguous` with reason `query_failed`
- **AND** no completion is proven and nothing is written

### Requirement: Read caps bound requests and promise no history depth
ABI SHALL bound one resolution's history read by a page cap and a window cap. The caps SHALL limit the number of exchange requests only and SHALL NOT be described or relied on as a guarantee that any period of history is covered. Reaching a cap SHALL yield `ambiguous` with reason `query_failed`.

#### Scenario: Busier period exhausts the cap before the cycle start
- **WHEN** the cap is reached before the window reaches the cycle start
- **THEN** the resolution is `ambiguous` with reason `query_failed`
- **AND** no single-leg completion is proven
