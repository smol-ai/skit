# Model Author History as Content-Addressed Revisions

Status: proposed. Supersedes ADR-0025's Draft revision model: its two pointers, retained
alternatives, retry keys, revision kinds and wire resolution provenance. ADR-0025's recovery
requirements stand unchanged.

## Context

ADR-0025 requires that every observed tree, including invalid content and both inputs of a
merge, stays recoverable. The implementation meets that requirement with a separate concept
for each case:

- an acceptance parent, a causal base and a merged input on every revision
- a history tip beside the current pointer, and a retain endpoint that moves only the tip
- `legacy`, `authored` and `merge` revision kinds
- retry keys with request hashes, and a prepared-upload checkpoint whose fate is found by
  walking causal ancestry
- resolution provenance with stages, sent on the wire

On the client, `pendingLocalFiles`, `pendingLocalBaseRevisionId` and `preparedUpload` form an
implicit state machine. Each concept was added to close a real gap, but together they describe
one thing several times, and the names leak those mechanics.

That one thing is a graph of immutable snapshots with a single movable pointer. Git proves the
model. None of the Draft history migrations, wire fields or local formats has shipped, so the
model can change now without a migration.

## Decision

Model author history as content-addressed trees, revisions with parents, and one
compare-and-swap pointer. Build it as four libraries, each usable without the others above it.

### Merge: a generic three-way merge

`Merge` merges any value from a base and two sides, `ours` and `theirs`. Mergers compose:
`whole`, `lines`, `set`, `record` (one merger for every key) and `struct` (a merger per field).
A file tree is a `record` of a file merger, and SKILL.md is a `struct` of frontmatter and body.

`Merge.run` returns `Clean { value }` or `Conflicts { conflicts }`. A `Conflict` is
`{ at, base, ours, theirs }`. A chooser is a plain function from a conflict to `"ours"`,
`"theirs"` or no choice. `Merge.prefer` tries choosers in order, and `Merge.resolve` applies
one. Every resolved conflict keeps both sides, so the result records each choice: there is no
separate decision record, and no single winner per file.

`Merge` knows nothing about skills, devices or the Registry.

### Store: trees and revisions

A `Tree` maps normalized paths to file contents and modes. Its identity is its hash. A
`Revision` is `{ tree, parents, author }`, where `author` is `{ device, at }`. An edit has one
parent, a merge has two, and the first revision has none.

A revision's identity is the hash of its tree, parents and author. Recording the same revision
twice yields the same identity, so retries are idempotent by construction. Because `author`
includes the time, A → B → A is three revisions that share two trees, as ADR-0025 requires.

One `Store` interface (`put`, `get`, `commit`, `revision`, `ancestors`) serves both the device
and the Registry. On the device it holds observations, sync bases and ADR-0026 compositions. On
the Registry it holds Draft history. The edit time of each path is read from the history,
rather than taken from the latest observation of the whole workspace.

### Remote: the Registry protocol

```text
POST /api/skits                                { owner, slug, visibility } → 201 (empty Draft)
POST /api/skits/:owner/:slug/revisions         { id, revision, tree }      → { id, diagnostics }
PUT  /api/skits/:owner/:slug/current           { expected, id }            → 200 | 409 { current }
GET  /api/skits/:owner/:slug/current                                       → { current, ... }
GET  /api/skits/:owner/:slug/revisions/:id                                 → revision and tree
GET  /api/skits/:owner/:slug/revisions?ancestors=:id&limit=&cursor=        → page
```

The protocol has two writes:

- `POST /revisions` records a revision. It never changes what is current. The server
  recomputes the identity, rejects a mismatch, and returns the existing revision if it already
  has it.
- `PUT /current` moves the one pointer, and only if it still points at `expected`. The `409`
  response means only "another device moved it first".

A backup is a revision that `current` does not point at; it needs no kind or endpoint of its
own. A merge is a revision with two parents, so the losing side stays reachable. Validation
diagnostics stay attached to each revision. Invalid content is still accepted, and publication
stays strict.

### Sync: a pure plan and an interpreter

The device keeps one value per Draft:

```ts
type SyncState =
  | { _tag: "Idle"; base: RevisionId | null }
  | { _tag: "Sending"; base: RevisionId | null; revision: RevisionId }
```

`Sync.plan(state, { local, current })` is pure. It returns one of:

- `UpToDate`
- `Pull(revision)`
- `Push(tree)`
- `Merge(base, ours, theirs)`
- `Blocked(reason)`

`Sync.run` is the only code that performs I/O: it commits, moves the pointer and writes files.

`Sending` replaces the prepared-upload checkpoint. After an unknown outcome, the device commits
the same revision again, which is idempotent, then reads `current`. Either `current` already
points at that revision, or the device moves it again.

`Blocked` carries ADR-0026's removal safety as data (`{ deleting, of, paths }`). Approval passes
back the same value, so it applies only to the exact inventory it described.

The plan's outcome is the command's status: `up_to_date`, `pulled`, `pushed`, `merged` or
`blocked`. A merge also reports its conflicts and the side each one kept.

## What stays

ADR-0025's requirements:

- every observed tree is saved locally before anything else
- invalid content is backed up
- an automatic choice never discards its alternative
- local preservation and acknowledged backup are separate states
- the observed inventory has an explicit filesystem scope

ADR-0026 is unchanged, except that compositions are trees in the device `Store`.

## What goes

- Wire fields: `history_revision_id`, `parent_revision_id`, `base_revision_id`,
  `merged_revision_id`, `revision_kind`, `expected_history_revision_id`, `request_key`,
  `request_hash`, and resolution `stage` and `policy`
- The retain endpoint and the separate history endpoint
- Client state: `pendingLocalFiles`, `pendingLocalBaseRevisionId` and `preparedUpload`, and the
  ancestry walk that resolves them
- Formats: the `merge-input-v1` key format, and the `legacy` kind for rows written by this
  branch
- The second file-tree merge layer (`shared/three-way-merge.ts`), and the
  `Settled`/`Decision`/`Resolution` vocabulary

Rows written before this branch become revisions whose only parent is the previous accepted
row. Their author is unknown, as ADR-0025 already notes.

## Open question

The overlap rule is now one chooser that `Sync` passes to `Merge.resolve`. Choosing it
(latest edit or later sync) remains a separate product decision. The rule itself stays behind
that one boundary, as ADR-0025 requires.

## Consequences

The three unshipped Draft migrations become one schema: `revisions`, `revision_parents`, trees,
blobs, and a `current` pointer per SKIT. The local history journal and sync bindings become the
device history store plus one `SyncState` per Author Workspace and SKIT locator. The diff3 core of `packages/skit/src/sync/merge.ts` survives
inside `Merge.lines`. The author-sync demo replays `plan` and `run`, so it follows the real code
path.

## Workspace write recovery (amended 2026-11-07)

Public Author operations own leases, backup acknowledgement and checkpoint
sequencing. Workspace and history storage capabilities stay private; Registry
transport receives no local writer or lease.

Before any tree write, save a durable Writing checkpoint naming the stored
before and target trees. Its single-use PreparedWrite is bound to the workspace,
lease owner and checkpoint revision; a later transition or released lease makes
it stale. Failed or partial attempts consume it too, so recovery prepares again.
Advance beyond Writing only after the writer has flushed the changes.

Stage on the workspace filesystem and flush written files and changed
directories before success. Refuse cross-device rename rather than silently
copying. Check all descendants, including ignored entries, before structural
replacement; a rescan does not grant authority over an externally replaced path.

If an interrupted write encounters newly authored edits, capture them and merge
with the pending target, then prepare a new Writing checkpoint for that result.
Unlike Library operation recovery, Author sync need not stop solely because the
author continued editing. Keep both merge inputs recoverable and report choices.

Capture and normalized scan must describe the same verbatim tree. Retry a
mismatch a bounded number of times, then report `LocalFilesChangedDuringSync`.
Backup reads workspace identity independently of connection metadata, so an
invalid connection cannot prevent preserving authored content.

A preview creates no workspace identity, connection or lease. It may cache a
remote content-addressed tree; such a cache write is idempotent. Credentials for
sync and publication must be resolved for the connected Registry's own origin.
