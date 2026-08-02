## ADDED Requirements

### Requirement: Entry-package Bybit calls use the resolved category, not global configuration
For entry-package create/amend/cancel/query payloads and instrument trading-rules
lookup, ABI SHALL source `category` from the resolved (or, for an existing binding,
previously stored) exchange instrument identity, rather than from the global Bybit
category configuration value.

#### Scenario: Create payload category comes from the resolved identity
- **WHEN** ABI builds the create payload for a new binding
- **THEN** the payload's `category` SHALL equal the resolved identity's `category`,
  regardless of the global Bybit category configuration value

#### Scenario: Instrument trading-rules lookup receives the resolved category
- **WHEN** ABI looks up instrument trading rules for a resolved symbol
- **THEN** the lookup SHALL be performed for that symbol's resolved `category`, and a
  lookup for the same symbol under a different category SHALL NOT reuse a cached result
  from this one

### Requirement: The correlation record stores the resolved category for reuse
The entry-package correlation record SHALL durably store `exchange_category` alongside
the existing `exchange_symbol`, so that a later amend, cancel, or query against the same
binding uses the category it was originally resolved with, without re-resolving the
ticker.

#### Scenario: A newly created binding's record includes its category
- **WHEN** ABI durably persists the record for a new binding
- **THEN** the record SHALL include the resolved `exchange_category` alongside
  `exchange_symbol`

#### Scenario: Amend and cancel reuse the stored category
- **WHEN** ABI amends or cancels an existing binding
- **THEN** ABI SHALL use that binding's stored `exchange_category` rather than resolving
  the ticker again
