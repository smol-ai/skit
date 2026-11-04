# Author sync representation and names

Terminology and ownership are updated by [ADR 0028](adr/0028-author-skills-through-revisions-not-drafts.md):
SKIT identities own revisions and Releases; Draft is no longer a separate entity.
The earlier implementation details below are retained as dated port/refactor evidence.

Base: `1c4f4be9a9`. Final comparison: this working tree against that commit.

The recovery states (`Idle`, `Sending`, `Writing`) and conflict/deletion policies
stay unchanged. This increment removes parallel file models and makes the owner
operations say what they do.

```text
Before
workspace scan → History.Tree (TreeEntry[])
Sync → historyTree
  ├─ convert files to Files (path → SyncFileVersion { bytes, mode })
  ├─ fileTree → rename alignment → record merge → text/frontmatter policies
  └─ rebuild TreeEntry[]
workspace workflow → readAuthorSyncTree / saveAuthorWorkspace
sync state file → loadBindings / saveBinding
```

```text
After
workspace scan → History.Tree (TreeEntry[], file variant TreeFile)
Sync → mergeAuthorTree
  ├─ index the same TreeFile values by path
  ├─ rename alignment updates each file's own path
  └─ merge files → text/frontmatter policies → same TreeEntry[]
workspace workflow → scanAuthorSyncTree / AuthorHistory.capture
sync state file → AuthorHistory.syncState.read / save / prepareWrite
```

`TreeEntry` owns the canonical file representation. The merger owns its temporary
path index; callers no longer choose between a file-record merger and a history-
tree merger. Rename alignment must update the stored path as well as its index.
Parsed frontmatter and SQL/R2 storage records still carry genuinely different
information; they are not removed merely to reduce the number of type names.

Names in the sync owner now identify `LoadedRevision`, `PlanInput`, and
`LocalRevision` directly. Loading planner input is `loadPlanInput`; scans say
`scan`, persisted metadata/history reads say `load`, and scanning and saving
history is `AuthorHistory.capture`.

First-sync setup is `NewDraft { remote, visibility }` or `ConnectedDraft { remote }`,
rather than an optional `firstSync` alongside a remote. Durable recovery remains
the same `Idle | Sending | Writing` state machine. `Sync.run` uses `Effect.fn`;
its state-save and workspace-write callbacks have independently inferred error
channels, so either owner can report a typed failure.

Malformed saved recovery state returns `AuthorSyncStateInvalid`, rather than a
defect. The caller gets repair guidance; the state file is not reset or replaced.
Persistent schema names, fields, and encoded tree contents remain compatible.
The existing revision-wide timestamp limitation is not changed by this refactor.

Validation on 2026-11-03:

- Core and CLI builds/typechecks passed.
- Core merge, rename, history, and sync tests: 105 passed.
- CLI author/history/sync/registration/decoding/publication tests: 145 passed,
  three Unicode-filesystem cases skipped on this macOS filesystem.
- Subprocess history tests: three passed, including contention and restart behavior.
- New malformed-JSON and malformed-state cases use the two-device workflow to
  verify typed failure, unchanged workspace/remote history/state file, and recovery
  after restoring the state file.
- Author command help, sync JSON stories, and saved-state failure rendering passed.
- Changed-code lint and formatting passed; diff whitespace checks passed.

Server runtime behavior was not changed; server tests and the full workspace suite
were not rerun. The port checkpoint is `1c4f4be9a9`.
