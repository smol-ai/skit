# Handle shared destinations as routing collisions

The custody-recovery incident does not require a new Projection identity model. A Binding states Harness and Scope; routing maps those inputs to a Projection Target. A Projection is the concrete Skill folder materialized at that destination. SKIT keeps local Library state version 2, whose current Projection records include a `harness` field as routing metadata. It does not introduce committed satisfied-Binding sets, reference-counted deletion, or authenticated device identity as part of this repair.

The motivating collision is narrow: if `$HOME` is itself the selected Git repository, a Harness whose global and repository targets share a relative path resolves both Bindings to one destination. Today that includes Codex at `$HOME/.agents/skills` and Claude Code at `$HOME/.claude/skills`. Similar collisions may arise from explicit custom roots. These are routing conflicts, not evidence that Projection ownership must be redesigned globally.

## Decision

Before filesystem mutation, a reconciliation operation resolves every selected destination through the existing shared path-observation boundary and groups routes that address the same physical directory.

For the initial implementation, two distinct Bindings selecting the same writable destination produce `TARGET_COLLISION`. SKIT explains which Harnesses, Scopes, and declared routes collided and writes nothing. For a `$HOME` repository collision, the operator chooses either the global or repository Binding for that Harness.

A later optimization may write once when every colliding route produces byte-identical rendered output and identical invocation policy. That optimization must first prove that disabling either Binding cannot delete or mutate bytes still required by the other. It is not required for the collision fix and must not introduce shared-Projection state implicitly.

If rendered output or policy differs, reconciliation always fails closed before mutation. SKIT does not compose Harness-specific renderers or silently choose one Binding's policy.

## Custody boundary

The concrete recovery work remains marker-aware orphan detection, an unhealthy `doctor` verdict for custody disagreement, reversible version-1-to-version-2 migration, and read-only diagnosis of older ledgers. Version-1 markers remain corroborating diagnostic evidence. Destructive cleanup requires the existing ledger, target and content checks, plus an explicit operator action; this effort does not promote markers into standalone deletion authority.

## Superseded direction

This decision supersedes ADR-0014's multi-Binding Projection bookkeeping and state-version-3 direction, ADR-0015's durable target-identity expansion, and ADR-0016's authenticated marker design. Their analysis remains historical context, but none is an active product requirement.

The pass-scoped path deduplication already used by audit and inventory remains useful and does not imply durable target identity. `projectionTargetPathIdentity` and `groupProjectionTargetCandidates` are retained only as pre-mutation candidate-grouping helpers for issue 08; their comparison evidence is not persisted. `pathIsWithin` also remains the shared lexical containment predicate.

The unused `projectionTargetRelocation` API, the standalone Projection Scope derivation API, and the exported marker-authentication module are removed in follow-up issue 09. They implement superseded durable-identity, shared-target, or device-authentication work and must not remain available for accidental integration.

## Consequences

- No state-version-3 migration is planned for this issue.
- Existing version-2 records retain their Harness routing metadata without redefining Projection in domain language.
- Collision detection is conservative, local, and pre-mutation.
- Experimental APIs not justified by collision detection are removed before this branch ships.
- The unusual `$HOME` repository case is safe without making it a central domain abstraction.
- Any future proposal for one Projection to satisfy several Bindings requires a separate product decision and concrete user need.
