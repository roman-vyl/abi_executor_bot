## ADDED Requirements

### Requirement: Close proves completion before acting on protection or exposure
After the existing pair classification, ABI SHALL neutralize the pair's own live entry order and resolve its own filled quantity `Q`; these are the only operations allowed before the first completion proof, and neither reduces exposure. ABI SHALL then evaluate the completion proof of `open-position-resolution` before cancelling any protection leg or dispatching any close order. On a proven completion ABI SHALL record it durably and return `trade_cycle_closed` with that closure, with no protection cancel and no close order. A contradictory proof SHALL yield `internal_error`.

#### Scenario: Stop filled before Runtime's close
- **WHEN** Runtime requests close for a cycle whose own stop already fully executed
- **THEN** ABI cancels no protection, dispatches no close order, records `terminal_closed` with reason `stop_loss`, and returns `trade_cycle_closed`

#### Scenario: Live entry remainder
- **WHEN** the pair's own entry order is still live when Close arrives
- **THEN** ABI cancels it and confirms it terminal before the completion proof

### Requirement: Close continues to a market order only from neutralized protection
Before dispatching a close order ABI SHALL require the protection class neutralized. Active protection SHALL be neutralized by the existing cancel procedure and then re-resolved; an accepted cancel SHALL NOT be proof that a leg did not execute. After neutralization: neutralized SHALL continue the existing close; completed SHALL be recorded and answered with that closure without a close order; any other class, including no candidates, SHALL yield `internal_error`. Unknown, partial or contradictory protection before neutralization SHALL yield `internal_error`.

#### Scenario: Stop fills during neutralization
- **WHEN** ABI cancels active protection and the re-resolved class is completed with role stop
- **THEN** ABI dispatches no close order and returns the `stop_loss` closure

#### Scenario: Children invisible after an accepted cancel
- **WHEN** the cancel was accepted and the re-resolved protection has no candidates
- **THEN** ABI returns `internal_error` and dispatches no close order

#### Scenario: Normal close with active protection
- **WHEN** protection is active, both legs are cancelled, and the re-resolved class is neutralized
- **THEN** ABI dispatches one reduce-only close order for exactly `Q` as today

### Requirement: Close never dispatches a market order on unproven own state
ABI SHALL NOT dispatch a close order when: the first proof is completed or contradictory; protection is unknown, partial or contradictory, or completed; protection after neutralization is not neutralized; any own protection leg shows executed quantity; the own entry is not proven terminal; `Q` is unresolved; the record is durably closed; or an earlier own close order's fate is unconfirmed. The final postcondition check SHALL require protection neutralized, not merely terminal.

#### Scenario: Same-side sibling and partial own stop
- **WHEN** this cycle's own stop executed part of `Q` and a same-side sibling holds a position in the slot
- **THEN** ABI dispatches no close order and returns `internal_error`

### Requirement: A repeated Close after a proven completion is answered from the record
For a `terminal_closed` record ABI SHALL return `trade_cycle_closed` with the stored closure, or for a legacy record the closure derived as in `open-position-resolution`, without exchange calls and without any order.

#### Scenario: Recovery retries Close after a stop exit
- **WHEN** Close is repeated for a cycle already recorded as closed by `stop_loss`
- **THEN** ABI returns the same `stop_loss` closure and sends no order
