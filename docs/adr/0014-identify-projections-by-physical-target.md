# Identify Projections by physical target

> Superseded by ADR-0017. Shared destinations are handled as routing collisions; this target-identity and state-version-3 direction is not active.

A Projection is one concrete Skill copy at one device-local Projection Target. Its identity is derived from the Skill reference and the canonical physical target, not from a Harness. Harnesses consume Projections; they do not own paths or define the identity of the files they read.

This distinction matters because a Skill Root may be native to one Harness or a compatibility root visible to several. In particular, project `.agents/skills` may be consumed by multiple Harnesses. The current catalog exposes that shared path as writable only for Codex; Claude Code, OpenCode, and Devin compatibility entries are read-only. Shared materialization is therefore latent rather than reachable through the current Library, but treating each `(Skill, Harness, root)` tuple as a separate Projection would become unsafe before another Harness or explicit route can write the same target.

## Model

A **Skill Root** is a concrete directory that a Harness may read. A Harness profile records each readable root, whether it is native or compatible, and the evidence for that claim.

A **Projection Target** is one canonical Skill Root on one device. The target owns the physical location used for materialization. Scope and declared root identity are derived, validated attributes rather than identity components; ambiguous derivation is a reconciliation condition and does not mint a second target.

A **Binding** continues to express desired availability for one Harness and Scope. Projection routing selects the writable Projection Target used to satisfy that Binding. Several Bindings may route to the same target. Incidental readability does not by itself satisfy a Binding: a Harness Binding is satisfied only when its routing decision names the target or reconciliation explicitly records that relation.

A **Projection** is identified by `(Skill Reference, Projection Target)`. It records the committed set of Binding keys it currently satisfies. Routing independently derives desired relations; disagreement is reconciled explicitly. Retirement depends on the committed relation set after explicit removals, never solely on recomputed routing. Compatible or detected consuming Harnesses are derived observations and are not part of Projection identity or Custody.

**Custody** attaches to the physical Projection. Its Ownership Marker records the Projection identity, Collection and Skill references, target identity, expected content hash, and transaction identity. It does not claim that a Harness owns the directory.

## Reconciliation invariants

- One canonical physical Skill path appears at most once in Projection state, even when several Harness profiles discover it.
- Enabling a Binding that routes to an existing compatible Projection adds a satisfied-Binding relation rather than creating or overwriting a second Projection.
- Adding or changing a satisfied-Binding relation re-materializes the target from the complete committed Binding-policy set. Rendering must be deterministic, commutative, and idempotent; incompatible policies are rejected before mutation and leave existing satisfied Bindings untouched.
- Disabling or removing one Binding removes its relation first. The physical Projection is retired only when no surviving Binding requires it and the ordinary hash and ownership checks succeed.
- A path with a valid Ownership Marker but no matching Projection record is an Orphaned Projection. It remains in SKIT Custody and makes local health unhealthy until re-indexed or safely released.
- A marker-free artifact remains Unmanaged. Compatibility with a Harness and presence beneath a known Skill Root do not grant Custody.
- Audit may report every compatible or detected consuming Harness, but it must not multiply one physical Projection into one entry per Harness.

## Target canonicalization required before state migration

ADR-0015 defines the canonicalization contract summarized here and is authoritative where this section was previously unresolved.

“Canonical” requires one shared implementation used by Library and audit code. The stored target must preserve the configured or declared path for display and relocation detection while using normalized physical evidence for equality during observation. The design must cover symlinks, Unicode normalization, filesystem case sensitivity, repositories nested beneath home, nested repositories, project moves, and explicit custom roots. Inode/device identity may detect aliases within one observation pass but is not persisted because atomic replacement changes inode identity.

Project-relative identity requires a stable repository identity that does not yet exist. Until that is resolved, moving a repository must be reported as a possible target relocation rather than silently producing an orphan plus a new Unmanaged observation.

A home directory may itself be the selected repository. In that case Codex's global and project `.agents/skills` routes resolve to one writable physical root despite carrying different Scopes. Canonicalization collapses the root to one target, gives the more-specific repository route precedence for reconciliation and display, retains both declarations as evidence, and surfaces incompatible Binding policies before any write.

## Marker trust required before destructive recovery

Version-1 Ownership Markers are corroborating evidence, not independently authenticated authority. They contain no target binding and can be copied or forged. A legacy marker without a matching ledger record may trigger an unhealthy orphan-candidate diagnostic, but it must not by itself authorize deletion or destructive re-indexing.

A replacement marker schema must be strictly validated, bind the marker to its target, and define how device authenticity is established. The preferred design is a device-local signing or MAC key with an explicit device identity. If authenticated markers are rejected, destructive recovery requires additional ledger or journal corroboration or explicit operator confirmation; re-indexing remains non-destructive.

Invalid marker syntax or shape is a first-class custody condition. It must not be silently treated as marker absence, and ledger/marker disagreements must be classified without aborting the diagnostic command.

## State and migration

The current version-2 state encodes `harness` in `ManagedHarnessProjection.projectionId`, transaction journals, tombstones, variants, and several diagnostic paths. Replacing that shape eventually requires a version-3 local state migration rather than reinterpretation in place. It is not coupled to the urgent version-1 to version-2 terminology migration or marker-aware diagnosis required by the 2026-09-04 incident.

For each version-2 Projection, migration derives a canonical target from its recorded root or Projection path and creates one satisfied-Binding relation from the former Harness and the matching Binding Scope. A Projection without a matching Binding migrates to a held orphan state with an empty committed relation set and is never automatically retired.

Version-2 records for the same Skill and canonical target cannot be merged merely by comparing their expected hashes because Harness-specific rendering intentionally produces different bytes. Migration must verify each record against the appropriate single-Harness render, compute the composed render for the combined Binding-policy set, and re-materialize transactionally. Genuine source or policy divergence becomes an explicit conflict and leaves version-2 state untouched.

The version-3 migration creates a timestamped backup, writes atomically, validates the complete ledger, migrates target-keyed variant evidence plus journals and tombstones, and supports byte-for-byte rollback.

Ownership Marker compatibility is preserved during migration. A legacy marker corroborated by its version-2 ledger record may preserve existing Custody, but an uncorroborated legacy marker cannot authorize deletion. The first successful reconciliation rewrites it with target-based identity. Until every relevant marker has advanced, readers must understand both marker versions and never infer absence of Custody solely from the older shape.

## Consequences

Projection transaction grouping and tombstones become target-based. Journals distinguish Binding-relation changes from physical retirement. Harness-specific invocation policy remains a materialization concern: routing prefers independently writable native targets; when several Bindings deliberately share one target, reconciliation composes the complete policy set before writing. If policies cannot compose and no safe alternate target exists, the new Binding is refused without degrading the existing Projection.

Variant storage keys by Projection Target rather than Harness. Diagnostics name the physical target first and then list affected Bindings and compatible Harnesses. Inventory canonicalizes and deduplicates roots before walking them.

Read compatibility is already shared even though cross-Harness write compatibility is not. Audit and health therefore deduplicate every physical observation before attaching its compatible or detected Harness set; they do not persist or display one Unmanaged or orphan condition per `(Harness, path)` pair.

This ADR introduces target identity independently of ADR-0006, which did not itself define Projection identifiers. Shared compatibility roots weaken ADR-0006's per-Harness drift-isolation property because an edit is visible to every consumer of that physical path; this is accepted only when the shared layout is imposed by a Harness or explicitly selected by the operator, and routing otherwise prefers independently writable native targets. This ADR also narrows the disposable-development-state premise in ADR-0011: content caches may be rebuilt, but a state file containing Projection custody requires explicit migration or marker-based diagnosis.
