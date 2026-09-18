# Canonicalize Projection Targets with declared and physical paths

> Superseded by ADR-0017. Pass-scoped path deduplication remains, but durable target identity and state-version-3 migration are not active requirements.

Projection Target identity needs two path forms because the path an operator configures and the directory the filesystem resolves are different facts. SKIT preserves both and does not promote pass-scoped inode evidence into durable identity.

## Path forms

A Projection Target records:

- `declaredPath`: the absolute, lexically resolved path produced by configuration and routing. It is stable across symlink retargeting and is the primary display path.
- `canonicalPath`: the byte-faithful result of resolving the existing directory through the host filesystem. It is openable and reflects the filesystem's preserved casing. Unicode normalization is never applied to a path passed back to the filesystem.
- observation evidence: `(device, inode)` when available, used only to collapse aliases within one inventory pass. For an unresolved path, the fallback comparison key is the lexically resolved path normalized to NFC.

`canonicalPath` is absent until the target directory first resolves. Before materialization, `declaredPath` carries provisional target identity. Route candidates whose unresolved comparison evidence suggests they may alias are one ambiguity set: SKIT does not mint several durable targets or write through them until parent resolution or explicit reconciliation distinguishes them. A lone unresolved candidate is not ambiguous and materializes normally. The first successful resolution records `canonicalPath`; from then on it is the durable device-local physical key while the target remains at the same location.

`declaredPath` and all other declared aliases are retained as attributes. A later canonical path different from the recorded one for the same declared path is a **possible target relocation** and requires reconciliation; it is not silently interpreted as an orphan at the old path plus an Unmanaged artifact at the new path.

Case behavior follows resolution by the host filesystem. On a case-insensitive filesystem, resolution yields the existing directory and aliases converge through observation evidence. On a case-sensitive filesystem, differently cased existing directories remain distinct. SKIT does not apply unconditional case folding.

Hard links, bind mounts, and dual mounts may converge through device/inode evidence during one pass. They do not acquire a permanent shared identity from that evidence because an atomic replacement changes inode identity.

## Scope derivation

Scope is not part of Projection Target identity. It is derived for each route and validated against the target:

1. An explicit custom route declaration supplies its intended Scope.
2. Otherwise, the innermost enclosing repository determines repository Scope.
3. A path outside the selected repository is global Scope.

When the selected repository is `$HOME`, global and repository Codex routes may both resolve to `$HOME/.agents/skills`. They collapse to one physical target. Repository Scope wins as the more specific route for reconciliation and display, while both route declarations remain attached as evidence. This precedence selects the derived Scope attribute only; it never discards either route's policy, because doing so could degrade a satisfied Binding. Different policies from those routes are a target-policy conflict; canonicalization never silently composes them.

Nested repositories and submodules follow the innermost selected repository. Explicit configuration may select an outer repository, but the mismatch is recorded as ambiguous Scope and blocks materialization until reconciled.

## Repository moves

SKIT does not yet have a stable repository identity that survives moves and fresh clones. Project targets therefore retain both the repository-relative Skill Root and the last resolved absolute paths. If the relative root matches beneath a newly selected repository while the previous absolute target is absent, SKIT reports a possible relocation. It does not automatically transfer Custody or authorize deletion at either location.

A future stable repository identity may make this reconciliation automatic, but version 3 must not invent one from a remote URL: forks, worktrees, remote changes, and repositories without remotes make that evidence ambiguous.

## Shared implementation

`packages/skit/src/platform/path-identity.ts` is the only path comparison boundary. Audit, Library inventory, target migration, and marker verification must use it. The existing `observationPathIdentity` contract remains pass-scoped. Durable target code extends the same module with the declared/canonical pair and relocation comparison; it must not introduce another realpath or normalization helper.

## Consequences

Custom roots and Harness compatibility roots that resolve to one directory produce one target with several declared aliases and a set of observing or consuming Harnesses. Scope disagreement and relocation are conditions on that one target, not reasons to mint duplicate identities.

Version-3 migration can now store declared paths and optional canonical paths without persisting inode keys. Marker version 2 can bind its authentication tag to a resolved canonical target path while also carrying the declared path for diagnosis; an unresolved, unmaterialized target has no marker. A copied marker fails target verification; a deliberately retargeted symlink becomes a relocation condition requiring reconciliation and a newly authenticated marker. Target binding alone does not establish device authenticity for a synchronized directory; the device identity and cross-device rules remain required from issue 06.
