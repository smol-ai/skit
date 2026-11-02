# Author sync after PR 118

Terminology and ownership are updated by [ADR 0028](adr/0028-author-skills-through-revisions-not-drafts.md):
SKIT identities own revisions and Releases; Draft is no longer a separate entity.
The earlier implementation details below are retained as dated port/refactor evidence.

This port starts from `6bc3bdeb7b` (PR 118 on dev). Its author implementation
comes from `924fbefc55`, with interrupted-workspace-write recovery from
`aa54cfde9`. The old combined `refactor/library-owner` branch is a recovery
source, not the base: its Library rewrite was ported separately into PR 118.

## Ownership before the port

Compared sources: `924fbefc55` (author) and `6bc3bdeb7b` (landed Library).
Low-level filesystem and HTTP calls are omitted.

```text
Author branch
author sync handler → syncDraft
  ├─ device history owns observed files and edit timestamps
  ├─ Sync.plan / Sync.run own Draft convergence and recovery
  └─ workspace adapter owns safe local writes and durable sync state
author registration → older Library import/install path

Landed dev
CLI / TUI → Library.plan / Library.apply / Library.import
  └─ Library owns state, writer, freshness, and installed skill changes
author sync handler → older one-shot Draft workflow
```

## Ownership after the port

Final comparison: this working tree against `6bc3bdeb7b`.

```text
author sync handler → syncDraft
  ├─ device history owns observed files and edit timestamps
  ├─ Sync.plan / Sync.run own Draft convergence and recovery
  ├─ Registry adapter owns immutable revisions and CAS current pointer
  └─ workspace adapter owns safe local writes and durable sync state
author registration → Library.import.authored
  └─ landed Library owns state, writer, and installed skill changes
```

The port preserves the landed Library boundary. Author sync does not install
skills or open the Library writer. Workspace identity/history are separate from
Library registration. The implementation must preserve both sides of conflicts,
invalid observed drafts, unknown upload outcomes, and interrupted local writes.

This increment covers explicit manual sync. Watchers, unattended sync, live
workspace installation, and demo changes are separate work. Tests and local
checks do not establish deployed Registry compatibility.

The Library's record merge also uses the carried-over generic `Merge` module
instead of the removed three-way-record helper. Library alignment, accepted-base
policy, and `--take-remote` choices remain with the existing Library workflow.
Registration and Library merge tests cover those integration points.

## Scope retained and deferred

Retained: immutable History trees/revisions, the local chronological journal,
safe inventory and local writes, the pure Sync plan/interpreter, Registry revision
storage and current-pointer protocol, and the existing manual command module.

Deferred in the archive refs: demo work, shared retained-file deduplication and
permission materialization, live per-skill compositions, enable-plan experiments,
and unrelated API cleanup. Neither relevant stash was applied.

The public command tree still omits `author`; the author sync command module is
exercised directly. The old product-loop E2E scenario remains skipped for that
reason. A passing workflow suite is not a public CLI or deployed end-to-end proof.

## Next slices

1. Fix conflict selection to use each path's authored edit history. `Sync.editedAt`
   currently computes one timestamp for the entire revision, and `authorDecider`
   receives only one timestamp per side. A newer edit to an unrelated file can
   therefore affect the winner at an older conflicting path (source-derived
   limitation; the existing tests prove same-path ordering, not this case).
   Define clock-skew reporting alongside this policy.
2. Decide how the manual author client becomes supported, then prove the real
   client against the Worker. Keep watcher lifecycle work after that journey.
3. Resolve deployment compatibility before applying migration
   `0010_draft_revisions.sql`: it deliberately drops old Draft snapshots and
   clears current pointers. Its assumption that Drafts are unused has not been
   checked against any deployed database in this port. Preserve or convert old
   data if that assumption does not hold.

## Recovery sources

Local `archive/*-2026-11-03` refs preserve the author-sync tip, combined
Library-owner tip, pre-rebase tip, and both relevant stashes. The stashes remain
in place. A verified full-history bundle also exists at
`/private/tmp/skit-author-sync-recovery-2026-11-03.bundle`.

## Validation

Local checks on 2026-11-03:

- Core build and core, CLI, and server typechecks passed.
- Core author/history/merge/sync/inventory/process tests: 160 passed, one skipped.
- CLI author/history/two-device/manual-sync/publish/Library-merge tests:
  157 passed, three skipped.
- Independent-process history tests: three passed.
- Library registration, JSON decoding, merge families/properties, contracts,
  and Storybook tests: 58 passed.
- Registry Draft/migration/inventory/publication/integrity/delete/auth tests:
  65 passed, using Cloudflare's local Worker and D1 test runtime.
- The rename-fixture test was adapted to Effect FileSystem and Schema decoding
  to meet current lint rules; its 13 tests passed after that edit.
- Author sync command help and sync result stories rendered successfully.
- Changed-code lint, formatting, and diff whitespace checks passed.

Skipped cases require a filesystem that distinguishes NFC/NFD names; this macOS
filesystem aliases them. Linux proof remains outstanding. Server tests initially
failed before execution because the sandbox blocked loopback binding; the same
focused tests passed with loopback access.

The full workspace suite was not run. Nothing was committed, pushed, or deployed.
