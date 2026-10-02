# Keep sync ancestry in Library state

## Status

Accepted

## Context

Library sync is a three-way merge. The accepted base is the portable manifest this home and the remote last agreed on; a record present in the base, absent locally, and unchanged remotely is a local deletion and is pushed as one. That inference is how deliberate removals reach other devices.

The accepted base lived in `library-sync.json`, beside `state.json`, and the two files were replaced separately. Sync published state and then wrote the base; push and clean wrote only the base. Neither replacement is fsynced. A power failure could therefore keep the newer base while `state.json` reverted, and restoring `state.json` alone from a backup did the same. The next merge read every record the base had gained as a local deletion and removed it from the remote and, through later syncs, from every device.

No merge rule can distinguish "the user removed this" from "this file lost the write". Detecting mismatched files with a revision stamp was rejected: it must be maintained on every sync path, has two mismatch directions with different safe answers, and still leaves two files to recover from.

## Decision

Sync ancestry is part of Library state. Schema-v8 `state.json` carries an optional `sync_ancestry` record of the origin, library identity, revision, and normalized base manifest the portable Library was last reconciled with. One atomic replacement of `state.json` publishes local state and its ancestry together.

- Push, pull, merge, and clean replace ancestry, in the same publish as the state they reconciled. No other workflow replaces it; every other mutation carries it unchanged, because a local edit after sync is exactly the divergence the merge interprets.
- Ancestry whose origin or library identity differs from the remote is `base_mismatch`.
- State without ancestry has no base. Equal local and remote portable manifests anchor ancestry through the clean path. Otherwise sync reports `adoption_required`, and `--adopt` merges against an empty base, which keeps one-sided records, reports differing records as conflicts, and never infers a deletion.
- `library-sync.json` is no longer read or written.

The v7-to-v8 migration happens once in the state-file loader and adds no ancestry. Only one person had used sync when this changed, so the sidecar is not migrated: each of their homes re-anchors on its first sync, or adopts once. The version bump makes older CLIs, which would still trust the sidecar, refuse v8 state instead of syncing beside it.

## Consequences

- The split-file data loss cannot occur: any version of `state.json`, including a whole-file backup, carries the base it was reconciled with.
- Restoring an older whole `state.json` replays its own ancestry. The merge interprets only edits made since; edits made after the backup and never synced are lost with the backup, which sync cannot recover.
- A remote write that commits without a response leaves state and its previous ancestry together. The retry re-merges against that coherent pair.
- `state.json` grows by one normalized portable manifest. Inventory output omits it, along with the storage `schemaVersion`, so storage changes no longer reshape `skit.inventory`.
- Arbitrary edits inside `state.json` that keep its ancestry are indistinguishable from legitimate local edits. The protection boundary is a coherent whole file, not tamper evidence.
