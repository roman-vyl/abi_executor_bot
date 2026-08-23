## Why

ABI has already built and validated the primitives needed for cycle-attributable native Bybit Partial protection and pair-scoped close, but production still routes single-owner traffic through legacy position-level protection and aggregate-position close semantics while same-side admission remains deliberately disabled. Change 8 is the destructive cutover that removes those mutually incompatible paths and makes cycle-owned native Partial lifecycle the only production model before same-symbol, same-side multi-owner operation is accepted.

## What Changes

- **BREAKING**: every production entry create, including the first and only owner of a scope, uses the canonical Bybit entry payload with `tpslMode="Partial"`; the legacy `Full` mapper behavior and any parallel Partial-entry mapper path are removed.
- **BREAKING**: `PUT .../protection` uses the native Partial child lifecycle for every active cycle. The position-level `/v5/position/trading-stop` write path, its owner-count routing, and `shared_scope_protection_unsupported` are removed from production behavior.
- **BREAKING**: close uses one cycle-owned, pair-scoped algorithm for one or many same-side owners. After neutralizing the own entry remainder and resolving final own exposure, ABI MUST deactivate and confirm the requested cycle's attributable Partial children before any market-close dispatch or resend; only then may aggregate sanity, stable-identity close recovery, exact own-execution proof, and terminalization proceed.
- Activate the existing side-aware scope admission classification: empty and same-side scopes are admitted; opposite-side and corrupt/ambiguous scopes fail closed. Remove the temporary exclusivity guard without adding a feature flag, compatibility alias, fallback, or owner-count branch.
- Preserve cycle isolation: protection and close resolve and mutate only children attributable through the cycle's own entry `orderLinkId`; sibling cycles and their protection remain untouched.
- Preserve existing durable correlation records and identities. No new store, generation model, Runtime contract, retry protocol, or public route is introduced.
- Preserve dry-run semantics and all existing demo/testnet live-write gates. Mainnet live execution remains blocked.
- Explicitly keep OCO/pair binding after direct child amend as unproven unless separately demonstrated; this change does not introduce an ABI-managed replacement OCO engine or rely on undocumented coupling.
- Non-goals: Runtime changes, Change 8 operational timeout tuning, multi-fill research, partial-close architecture, public API expansion, protection surrogate policy, and any continuation of legacy execution paths.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `entry-package-execution`: make canonical native Partial attachment mandatory for every live entry create and remove the legacy Full/parallel-mapper choice.
- `protection-execution`: activate the existing native Partial lifecycle as the sole protection write path for single- and multi-owner scopes, with cycle-attributable verification and no shared-scope rejection.
- `close-execution`: make pre-close own-child neutralization followed by pair-scoped, own-fill-derived close the sole close algorithm regardless of owner count.
- `position-scope-exclusivity`: replace production single-owner admission with the already-defined side-aware admission outcome, allowing multiple same-side active cycles while rejecting opposite-side or corrupt scope state.
- `abi-position-management-api`: remove `shared_scope_protection_unsupported` from the closed error vocabulary and make protection/close success reflect the cycle-owned native lifecycle.
- `native-partial-protection-attribution`: promote the attribution resolver from production-inert evidence to the mandatory production ownership boundary while retaining its fail-closed ambiguity semantics and no-new-durable-state property.

## Impact

- Exchange mapping and transport orchestration in `src/exchange` and `src/execution`: one canonical Partial entry payload; no production `setTradingStop` lifecycle.
- Entry-package, protection, close, and scope-admission services in `src/services`: same-side activation and one cycle-owned lifecycle for every owner count.
- Existing correlation repository and deterministic order identities remain the durable source of cycle ownership; their schema does not change.
- Public protection and close routes keep their request shapes, but the protection error vocabulary removes the temporary shared-scope rejection and successful behavior changes to native attributable child reconciliation.
- Tests must prove both single-owner and same-side multi-owner behavior use the same path, sibling isolation, fail-closed opposite-side/corrupt admission, idempotent retry/recovery, and absence of calls into removed legacy paths.
- Rollback is by Git history/branch boundary, not by runtime flag or dual-path fallback.
