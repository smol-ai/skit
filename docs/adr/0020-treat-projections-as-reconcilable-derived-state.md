# Treat Projections as reconcilable derived state

## Decision

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
scope closes. The installed `4.0.0-rc.112` source and types are authoritative for these APIs.
