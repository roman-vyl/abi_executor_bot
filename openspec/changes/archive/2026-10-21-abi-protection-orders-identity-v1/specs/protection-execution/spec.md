## ADDED Requirements

### Requirement: A successful reconciliation returns the legs that proved it
A reconciliation reported as satisfied (no write) or reconciled (after amend) SHALL carry the attributed stop and take legs of the fresh read that proved it: the matching initial read when no write was sent, the matching post-amend read-back otherwise. It SHALL NOT substitute values from the write plan, the request or an earlier read. This adds no exchange request and changes no success or failure condition.

#### Scenario: Reconciled after amend
- **WHEN** an amend was sent and the read-back matches the desired state with no terminal leg
- **THEN** the outcome carries the read-back's stop and take legs

#### Scenario: Already satisfied
- **WHEN** the initial read matches the desired state with no terminal leg
- **THEN** the outcome carries the initial read's stop and take legs and no amend is sent
