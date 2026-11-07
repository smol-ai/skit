# Author skills through revisions, not Draft objects

Status: accepted for the author-sync branch. Replaces the Draft entity language
in ADRs 0025–0027; their history and recovery requirements still apply.

The original design comparison started from `1c4f4be9a9`. The compatibility section
below reflects the final unreleased owner representation, superseding the dated
working notes and their intermediate formats.

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
- Migration `0010_owner_schema.sql` upgrades the dev schema after `0009`. It
  discards unreleased Draft content and pointers, retains SKIT rows and Releases,
  and gives each SKIT no current revision. Identity, credentials and Library data
  are retained. See `docs/self-hosting.md` for the deployment ordering.
- Local Author checkpoints start at `skit.author-sync.v1` in `author-sync.json`,
  with checkpoints indexed by workspace and SKIT locator. Branch-only intermediate
  formats are unsupported; no author command or `sync-bindings.json` writer was
  published, so there is no legacy Author checkpoint loader.
- Author sync/list/delete contract IDs change with their output fields.

Validation must cover current-revision publication state, invalid-content sync,
publication, deletion, and unchanged interruption/conflict/deletion safeguards.
`packages/skit-server-effect/test/owner-schema-migration.test.ts` proves the
supported dev upgrade retains identity, credentials, Releases and Library state
while discarding Draft content. Author checkpoint and recovery proof lives in
`packages/skit/test/author-backup-state.test.ts` and the CLI author-world,
structural-sync and history-backup tests. Historical v2→v3 loader results from
November 3 describe a superseded branch representation, not current compatibility.

No deployment or live database upgrade is established by these local checks.
