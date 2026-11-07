# Treat Projections as reconcilable derived state

The [durable Library operations amendment](#amendment-durable-library-operations-2026-11-07)
supersedes the no-journal rule for operations spanning Library state and folders.

## Original decision

Library state and retained artifacts are authoritative. Harness Projections are derived copies.
SKIT serializes local commands for one Library home, prepares replacement trees in scoped random
directories on the destination filesystem, verifies custody, applies the filesystem changes, and
publishes Library state once.

SKIT does not persist a Projection transaction journal or attempt to make directory changes and
`state.json` one cross-media transaction. Effect scopes clean staging directories after success,
failure, defect, or cooperative interruption. They make no claim about `SIGKILL` or power loss.

A valid ownership marker whose recorded hash matches the directory identifies reproducible managed
content even when its hash is ahead of committed Library state. A retry may therefore replace that
tree from retained content. A missing Projection is rebuilt. Foreign content is never overwritten.
Modified managed content is preserved as a variant and the mutation reports a conflict without
replacing it.

## Consequences

- Successful Projection mutations write `state.json` once.
- Failure before publication leaves the previous state authoritative. Some derived directories may
  already reflect the attempted change or be absent; retrying the mutation converges them.
- Random staging directories are implementation garbage, not recovery records. Correctness does
  not depend on discovering a particular temporary pathname.
- `LibraryStore.publish` needs no commit callback.
- Ownership markers no longer need transaction IDs. Existing version-1 markers containing one
  remain readable as legacy provenance.
- The former prepared/materialized/committed/rolled-back journal and reverse rollback contract are
  retired.

## Effect reference

`Effect.acquireUseRelease` guarantees uninterruptible acquisition and release around a use phase.
`FileSystem.makeTempDirectoryScoped` supplies a random temporary directory and removes it when the
scope closes. The installed `4.0.0` source and types are authoritative for these APIs.

## Amendment: durable Library operations (2026-11-07)

The no-journal decision above applies to the former Projection transaction
protocol. Library operations now record their intended work in `state.json`;
this supersedes the earlier claim that scoped cleanup and retry alone suffice
for operations spanning Library state and folders. Device state remains in files.

State and the operation record publish in one atomic replacement. Record the
steps and their before-evidence before changing folders. If a step needs the
output of an earlier step, save its after-evidence in the same state write that
marks the earlier step Done. Recovery skips verified completed effects, repeats
steps whose before-evidence still matches, and otherwise stops and reports.
It never rolls back automatically.

A stopped setup does not block unrelated Library changes. It can be undone or
replaced, not resumed. Pending and Stopped records remain until undone; a Done
setup remains until a later setup replaces it, preserving evidence for undo.
Library undoes its folders and state; MachineSettings independently restores
only the discovery settings saved for that setup. Neither owner writes the
other's state.

Only operation records in `state.json` support setup undo. The unreleased
`removed/<id>/setup.json`, `changes/` and undo-attempt formats have no migration.
A pending Update without `updateSelection: "reviewed"` stops before preparation
or replay because its recorded scan cannot establish what the user approved.
Existing released Library and machine-settings formats retain their compatibility.
