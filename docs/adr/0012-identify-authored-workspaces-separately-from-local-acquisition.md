# Identify Authored Workspaces Separately from Local Acquisition

An authored working tree that participates in the local Library uses an `authored-workspace` Collection Identity profile. It is not a `local-collection` created by `skit add .`, and it does not borrow the canonical Registry identity of a published Release.

The distinction is semantic:

- `local:<absolute-path>` identifies an arbitrary local Source acquired as a snapshot through `skit add`;
- `authored:<workspace-id>` identifies one editable Author Workspace on one device; and
- `skit:<authority>/<namespace>/<slug>` identifies a Registry-qualified SKIT retained as an immutable Release.

These Entries can coexist because they represent different retained relationships. Artifact metadata in `skit.json` establishes that a directory is an authored SKIT, but its slug is not globally unique and does not identify one local checkout. `skit.remote.json`, when present, identifies the canonical Author home but does not turn mutable working-tree content into the immutable Registry Release Entry.

## Workspace identity

The CLI creates an opaque workspace identifier when it first registers an authored working tree. The identifier is stored in ignored, device-local workspace metadata that moves with the directory but is not committed, included in the SKIT Artifact, synchronized to the Registry Draft, published in a Release, or copied through the portable Library Manifest.

The resulting Collection Reference is `authored:<workspace-id>`. Human output uses the Descriptor slug and an explicit `editable authored workspace` label; ordinary users should not need to copy the opaque reference unless two visible workspaces require disambiguation.

This identity has the following properties:

- moving the directory on one device preserves the Entry and its Bindings;
- a fresh clone creates a distinct workspace identity and editable Entry;
- recording or migrating `skit.remote.json` does not re-key the Entry;
- publishing, retaining, or deleting a Registry Release does not re-key or remove the Entry; and
- copying device-local workspace metadata into another live checkout is detected rather than silently aliasing two mutable directories.

The absolute path remains the editable Source Locator and can change independently of Collection Identity. Library state maps the stable workspace identity to its currently observed path.

## Author and Library lifecycle

`skit author init` ensures the editable Entry exists after authored metadata is valid. Author operations on an existing SKIT also ensure it idempotently so a fresh clone can enter the same workflow without a separate registration command. This does not create a Binding or Projection.

Ordinary `skit enable` and `skit disable` manage authored Skills through the existing Library Binding, Projection, Custody, and conflict model. There is no Author-specific enable/disable surface.

`skit pull <authored-workspace-ref>` is the offline operation that re-reads the working tree, refreshes the retained Artifact, and reconciles existing Bindings. It works before a remote home or Registry exists. `skit author sync` remains solely responsible for working-tree and Registry Draft synchronization; it may diagnose a stale editable Entry but does not mutate Library or Projection state.

This separation reuses the existing local Source refresh and reconciliation outcomes without coupling a successful remote Draft write to an independently failing device-local Projection write. Truly live Projections remain a separate decision requiring an explicit filesystem adapter and safety contract.

Removing an editable Entry is an explicit opt-out. Author commands must not silently resurrect a deliberately removed Entry; device-local workspace metadata records that choice until the user explicitly registers the workspace again. Removing Library state never removes or edits the authored working tree.

Running `skit add .` inside a registered Author Workspace is rejected with remediation to use the existing editable Entry. Snapshot acquisition remains available only through an explicit future surface if a concrete journey requires both a snapshot and editable Entry for the same directory. It must not happen accidentally through the legacy local-source path.

## Relationship to prior decisions

This refines ADR-0002 by keeping Author Draft and Library synchronization as separate operations while allowing authored content to participate in the same local Library Projection model. It preserves ADR-0003 and ADR-0011: `skit.json` still carries no Registry identity, and unboundness remains structural rather than encoded through a sentinel.

ADR-0011 intentionally assigns source-derived identity when an authored artifact is acquired from GitHub, generic Git, or a local path through ordinary acquisition. That remains true. An Author Workspace is not ordinary acquisition: it is a mutable checkout recognized through the Author lifecycle, so it receives the separate non-portable `authored-workspace` profile.

This also preserves ADR-0005's identity catalog. The implementation adds a versioned, `portable: false` profile instead of special-casing reference strings outside the catalog.

We reject reusing `local:<path>` because Location is not authored workspace identity: directory moves would strand Bindings and ownership markers, while two clones need distinct mutable identities. We reject using the Descriptor slug because it is not unique. We reject using Registry identity because an unbound workspace has none and a bound mutable workspace is not an immutable Release. We reject putting the workspace identifier in committed metadata because clones and forks must not silently share one device-local mutable identity.
