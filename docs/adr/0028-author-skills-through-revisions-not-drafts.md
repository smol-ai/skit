# Author skills through revisions, not Draft objects

Status: accepted for the author-sync branch. Replaces the Draft entity language
in ADRs 0025–0027; their history and recovery requirements still apply.

Comparison base: `1c4f4be9a9`, plus the uncommitted representation/naming refactor
documented in `docs/author-sync-refactor.md`. Final comparison: this working tree.

An author edits skills in a workspace. The Registry identity already names their
collection (which may contain one skill). Its revisions, current revision, and
Releases belong to that identity. A separate Draft entity adds no identity or
lifecycle that the skill collection needs.

```text
Before
author sync → Draft API → Drafts
  └─ owns a SKIT's identity, visibility, current pointer, revisions and trees
publication → reads Draft current → validates → creates a Release
author inventory → reports draft_revision_id
```

```text
After
author sync → SKIT authoring API → Skits
  └─ owns identity, visibility, current revision, revisions and trees
publication → reads SKIT current revision → validates → creates a Release
author inventory → reports current_revision_id and current_revision_published
```

Unpublished describes a revision that no Release references. It is independent
of validity: unfinished/invalid content still syncs, while publishing requires
valid content. Publishing does not move current or prevent continued editing.
There is no replacement Draft-like entity or persisted `draft` lifecycle flag.
The current revision's publication state is derived from Release history.
Publication no longer queries and decodes the current-pointer row itself: it
calls `Skits.current`, leaving that state and its representation with its owner.

## Compatibility

- The pre-release authoring API keeps its `/api/skits` current/revisions routes,
  but group names, responses, error codes and discovery use SKIT/revision terms.
  Client and server must be updated together. Released consumer/Library routes
  and Release version semantics do not change.
- A new migration renames existing Draft tables into SKIT/revision tables,
  preserving rows, current pointers, tree identities and parent relationships.
  Historical migrations remain unchanged. Migration 0010's earlier destructive
  assumption remains a separate deployment issue, documented in the port notes.
- Existing R2 blob keys keep their historical prefix; vocabulary changes must
  not orphan uploaded bytes.
- Client sync-state v3 uses `skits` instead of `drafts`; the loader reads v2 and
  carries every `Idle`, `Sending` and `Writing` checkpoint forward unchanged.
  Old v2 files are upgraded only when sync next saves state.
- Author sync/list/delete contract IDs change with their output fields.

Validation must cover migration preservation, client v2 recovery-state loading,
current-revision publication state, invalid-content sync, publication, deletion,
and unchanged interruption/conflict/deletion safeguards.

## Validation on 2026-11-03

- Core, CLI and server typechecks passed; core and CLI builds passed.
- Core protocol/authoring/history/merge/sync tests passed (123 tests), plus
  directory validation and invocation conformance (68 passed, one filesystem
  case skipped; invocation tests overlap the previous set).
- CLI sync/list/delete/publication/contracts/Storybook tests passed: 127 tests,
  three Unicode-filesystem cases skipped. The validation-command test also passed.
- The v2 checkpoint cases passed for `Idle`, `Sending`, and `Writing`: previews
  leave old state unchanged, the next save writes v3, edits converge, and the
  original revision remains the parent rather than becoming a spurious new root.
- Focused Worker/D1/R2 tests passed across 11 files (70 tests). Two inventory
  fixtures were corrected for the added publication field and their files passed
  on recheck. Migration tests compare every old/new row and check foreign keys.
- The real HTTP publication journey proves unpublished → published → new
  unpublished revision, failed publication of invalid content, and returning to
  an already published revision. Publishing never moves the current pointer.
- Author-list and sync stories rendered with the new terminology and status;
  author-sync command help passed a check for workspace/revision language.
- Contract generation, changed-code lint/formatting and whitespace checks passed.

No full workspace suite, deployment, or live database migration was performed.
