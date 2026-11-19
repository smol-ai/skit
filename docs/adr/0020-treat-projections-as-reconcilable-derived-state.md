# Treat Projections as reconcilable derived state

The [durable Library operations amendment](#amendment-durable-library-operations-2026-11-07)
supersedes the no-journal rule for operations spanning Library state and folders. The
[Library database amendment](#amendment-library-database-2026-11-14) supersedes where that
amendment keeps its records.

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

## Amendment: Library database (2026-11-14)

The 2026-11-07 amendment kept operation records inside `state.json`. Each ordinary apply
recorded a full before and next Library and nothing removed it, so one Library reached 34 MB
with 1.1 MB of state. Every load decoded those records and every save rewrote them.

Library state, operation records, audit events, Machine Settings, and Author checkpoints
and history metadata share `<home>/library.sqlite`. Each owner saves its own rows.
A publication can commit its state changes, operation progress, and audit event in one
transaction.

- The Library reconstructs its state from rows. The accepted sync base and current Library
  rows commit together, as required by [ADR 0023](0023-keep-sync-ancestry-in-library-state.md).
  Operation programs have their own rows.
- Operation records are rows. Library records an operation before any folder changes, saves
  progress against the record it read, and settles it once. A save or settle whose base record
  has moved fails `LibraryChanged`. Settling never recreates a missing or settled record.
- An audit event is a row saved in the same transaction as the change it describes. One action
  accumulates its changes in one event, including across a resumed operation, and an event is
  already stored when a workflow fails after a save. History omits an event while an operation it
  covers is Pending. There is no outbox, delivery step or startup retry. Another process reading
  history during a write may briefly see an event before its later changes are added; history is
  diagnostic and never drives reconciliation.
- The state revision covers Library state only. Progress on a record no longer makes an
  unrelated reviewed plan stale. An undo plan also depends on its target record and that
  target's undo records.
- The home lock still serializes workflows across processes. The step engine checks folder
  evidence before changing a folder, and recovery resumes a recorded operation. Setup and
  Undo can commit Machine Settings and Library progress together.

### Why not a separate journal beside `state.json`

A journal in a second file needs proof that a record belongs to the state beside it. Matching a
step's captured before or next state cannot tell a crash from a `state.json` restored to the
same content, and Import, Remove, Restore and root preparation check folders, not Library
state. ADR-0023 records what a sidecar that outlives its state costs. t3code, opencode and
alchemy were read at their latest revisions; each keeps state and progress in one transactional
store or one record. One store removes the question.

### Importing released files

`state.json`, `audit.jsonl`, and `machine.json` shipped in 0.3.0. Each store imports its
own files. SKIT builds and verifies a fresh database schema in a temporary directory, then
links it into place without replacing an existing database. The import holds the released
`.lock` while publishing source backups and refusal files.

- Library state, operation records, and undelivered audit drafts are imported into SQLite.
  SKIT archives the raw legacy operation records, including completed ones, and can keep
  supported Pending and Stopped programs available for recovery. The audit importer retains
  the event objects and their extensions.
- The Library commits the import before replacing `state.json` with a version the old CLI
  refuses. If interrupted in that interval, a retry checks the original hash and finishes
  publication. A changed source is kept for inspection.
- Machine Settings first saves and flushes the original `machine.json` as
  `machine.json.backup-database`. It then publishes and flushes the old-reader refusal file
  before committing the rows. A retry can import the backup if interrupted in that interval.
  Released repository commands read this file even when they never open Library state.
- Both Node and Bun use the shared SQLite store. A read can leave SQLite sidecar files in
  the home.

### Keep complete Author bytes through recovery

Author file bytes are saved before their database registration. An interrupted
save can leave a complete hash-named file without a row. SKIT keeps these files
indefinitely and verifies and reuses them on retry. Recovery can also read their
verified bytes before registration. A missing row alone is therefore
insufficient evidence for deletion. These files use disk space until the home is
removed and are part of a full-home backup.

### Back up and restore a SKIT home

1. Stop SKIT commands, watch processes, and any terminal UI using the home. Keep them stopped
   until the copy finishes so the database, content files, and recovery records have the same
   point in time.
2. Copy the entire home directory to a separate location, preserving permissions and symlinks.
   This includes `library.sqlite` and any SQLite sidecars present, Author bytes under
   `file-bytes/`, Library content under `originals/` and `variants/`, history files,
   retained folders, old-reader refusal files, and import backups. The SQLite database
   contains the references and integrity checks for Author bytes, while the files contain
   the bytes themselves.
3. Restore into a new, isolated directory. Use that directory as the SKIT home and check that
   you can read the Library and Machine Settings and open a known Author revision and its
   file contents. When restoring a home to resume work on the original machine, keep the
   original copy until you have checked the restored home and reconciled any newer remote
   changes. Restoring an older Library can make sync interpret missing records as deliberate
   deletions.
4. Back up authored workspaces and any folders outside the SKIT home separately if you need
   their working contents. The home stores device settings and can refer to their original
   absolute paths.
