## ADDED Requirements

### Requirement: Attribution remains read-only and is the production protection-ownership boundary
Attached-protection attribution SHALL remain a fresh, read-only capability with no new correlation
field, durable store, or cache. Change 8 production consumers SHALL use its exact-parent, fail-closed
result as their mandatory ownership boundary for native Partial protection reconciliation and close
cleanup. The resolver itself SHALL perform no exchange write and SHALL NOT alter any public HTTP
schema or error envelope.

#### Scenario: Resolving attribution performs no durable or exchange write
- **WHEN** ABI resolves a trade cycle's attached protection
- **THEN** it reads only the cycle's own entry `orderLinkId` from durable correlation for attribution
- **AND** it neither writes durable state nor sends an exchange mutation

#### Scenario: Production protection consumes only a clean attributed pair
- **WHEN** `PUT .../protection` needs to inspect or amend native children
- **THEN** it proceeds only from this capability's clean exactly-one-stop-and-one-take result
- **AND** `none`, ambiguity, or query failure cannot be replaced by heuristic attribution

#### Scenario: Production close cleanup consumes only exact attribution
- **WHEN** close determines which native Partial children belong to the requested cycle
- **THEN** it acts only on exact child identities returned by this capability
- **AND** it never infers ownership from symbol, side, price, timing, or aggregate position

## REMOVED Requirements

### Requirement: This capability introduces no new durable state and changes no production behavior
**Reason**: Change 8 intentionally activates the resolver in production protection and close paths, so
the former production-inert guarantee and its `Full`-entry/legacy-protection scenarios are no longer true.

**Migration**: Preserve the resolver's read-only/no-new-durable-state boundary while requiring production
consumers to act only on its clean exact-attribution result, as specified by the added requirement.
