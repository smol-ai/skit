# Pin portable Git Source Revisions

## Decision

A retained Git Entry has a tracking Source and a resolved commit. Its Collection
Identity excludes both the tracking ref and the commit. Its Content Digest remains
independent evidence of the retained Artifact.

`skit.library.v2` requires an Entry `revision` variant:

- `git`: full `commit` (40 or 64 lowercase hexadecimal characters) and
  `tracking_ref` (a ref string, or `null` for the remote's default branch).
- `release`: Registry Release `version`.
- `unversioned`: a Source that supplies no portable immutable revision.

The locator preserves the repository URL and selected subpath. Its `ref` fragment
must agree with `tracking_ref`; acquisition refuses disagreement. Git commits are
never placed in the Collection Reference or represented as Registry Release versions.

Ordinary sync fetches the recorded commit explicitly and checks out its detached
commit before discovering the selected subpath. Identity and Content Digest must
both match before retention. Fetch does not use a shallow history because
normalization derives Skill modification times from Git history. An unavailable
commit fails with the revision, remote, and remediation; there is no branch fallback.

Explicit `skit update` (and `skit pull`) resolves the retained locator again:

| Tracking input            | Explicit update                                    |
| ------------------------- | -------------------------------------------------- |
| Branch or full branch ref | Fetch its current commit                           |
| Tag or full tag ref       | Fetch its current target, including a moved tag    |
| Full commit ID            | Fetch the same commit; stays fixed                 |
| Omitted ref               | Fetch the remote's current default branch (`HEAD`) |

An omitted ref follows changes to the remote's default branch selection; it does
not remember the branch name selected at first acquisition. Use an explicit ref to
track a named branch. Full commit IDs are fetched as objects, never as branch names.

## Breaking development contract

There is one supported manifest format, v2. There are no optional Git revision
fields, v1 decoder, automatic manifest migration, or dual-format writes. Upgrade
CLI and Registry together. Old remote manifests must be recreated by their owner
or operator; this change does not reset deployed Libraries. Old local sync
checkpoints retain the existing invalid-checkpoint behavior: ignore the checkpoint
and re-derive intent from the current remote manifest.

Existing locally retained Git Entries with a recorded commit export that evidence.
Entries without one cannot be exported. Run an explicit update on the retaining
device to choose today's content, then sync. SKIT does not claim that today's HEAD
is the missing historical revision, nor silently replace retained content on sync.

Sync JSON is `skit.library.sync.v2`; pin output and pin preview are `skit.pin.v2`
and `skit.pin.plan.v2` because they embed portable Entries. These carry the full
commit. Human plans and Entry lists show twelve commit characters and plans include
the tracking ref. Local Entry JSON retains the full `sourceRevision` and Source.

Optimistic remote revision checks, per-Entry transaction boundaries, and Projection
Custody safeguards continue to apply.

## Evidence

Disposable local SHA-1 and SHA-256 Git repositories exercise second-device reconciliation after
upstream changes, selected subpaths, explicit updates, identity/digest refusal,
unavailable commits, and missing local historical revisions. Registry tests reject
old/incomplete contracts and round-trip full Git pins with optimistic concurrency.
