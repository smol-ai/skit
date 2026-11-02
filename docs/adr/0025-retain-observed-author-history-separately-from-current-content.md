# Retain Observed Author History Separately from Current Content

> Partially superseded by ADR-0027 (proposed): if accepted, its content-addressed revisions
> replace this ADR's two pointers, retained alternatives, retry keys and revision kinds. The
> recovery requirements here still stand.

Status: accepted direction; client integration is in progress. The overlap winner
rule remains provisional pending product confirmation (tracked in Arc).

This builds on ADR-0012's device-local Author Workspace identity. An Author
Workspace is a human-owned folder, independent of installed copies and any Git
repository. SKIT never changes `.git`, commits or pushes as part of author sync.

## What recovery means

Every tree SKIT observes must first be saved in device-local chronological
history, including invalid content. Successfully uploaded observations must be
recoverable off-device even when they never become the current Draft. An offline
sequence A → B → C is three observations, not just an eventual upload of C.
If a clean merge produces M from authored L and remote R, preserving M alone
does not preserve the exact authored L. Older observations and such merge inputs
are concrete consumers of retained alternatives.

Observation is a real boundary: saves that happen entirely between scans are not
recorded. Debouncing does not justify claiming every filesystem write was saved.
Local preservation and acknowledged remote backup are separate states. Offline
content cannot be recovered from a lost device until its backup is acknowledged.
Retention budgets and thinning must be explicit before continuous recording ships.

The observed inventory must have an explicit filesystem scope. Current local
history preserves directories, symlinks and executable bits, excludes Git/SKIT
control paths and respects `.gitignore`; current Draft transport is file-only.
Those differences must be resolved or surfaced before claiming an exact off-device
backup of that inventory. Git ignore rules are not permission to silently promise
recovery of files that were never recorded.

Immutable content-addressed trees and append-only observations remain distinct.
A → B → A shares tree bytes but has three ordered observations. Restore records
a fresh authored edit after backing up current content; it never rewrites history.
Validated Library Collection Versions and published Releases are not edit history.

## Two pointers, one revision identity

Draft revision IDs identify retained server content. `parent_revision_id` is the
previous server-accepted revision, including archival alternatives. It is an
acceptance-order link, not necessarily the previous current content. The separate
`base_revision_id` records the causal input used by an authored operation.
`history_revision_id` names the acceptance tip; `current_revision_id` names the
canonical content. Retaining an alternative changes only the history tip.

A restore UI must use provenance and causal bases rather than treating every
acceptance parent as a previous current version. Old rows retain their IDs and
links and are explicitly labelled `legacy`, since their authored-versus-merge
provenance cannot be reconstructed honestly.

Retry keys identify immutable requests and prevent an acknowledged or ambiguous
retry from creating another accepted operation. They are derived from durable
local observations; they do not introduce a second edit-identity model. Reusing
a key with different intent is rejected. Bound-workspace PUT recovery uses the
implemented durable prepared-upload checkpoint: files, bundle hash, request base
and observed local files are flushed before the request. On an unknown outcome,
recovery follows `base_revision_id` from the captured content head through history
pages and finds the nearest matching bundle. An archival sibling is not evidence
of acceptance. This advances the base before replaying newer local changes. No
Write request key is added; archival request keys remain distinct. Equality with
today's head alone cannot prove an old operation was never accepted. First
creation, unavailable ancestry and explicit restore/ABA intent remain hardening
work.

## Provisional conflict policy

First merge independent text changes. If a synthesized structured file fails
syntax while both inputs parse, hand it to the overlap rule. Do not turn this
check into a validation gate on independently authored invalid content.

The provisional overlap rule is **the later synchronizing authored intent wins**,
not the edit with a later device timestamp. A day-old offline edit can therefore
win when it reconnects. Causal descendants win; edit beats concurrent deletion.
The winner rule must remain replaceable behind one domain boundary. Same-point
insertion union and agent-assisted merging are deferred product choices.

Archiving an older observation is backup, not a fresh edit and not a reason to
make that content current. Pulls, retries and automatic merges create no new
authored intent. Before any automatic choice, retain the alternative it would
otherwise discard and record enough provenance to restore or swap it in one step.
A local deletion losing to a remote edit needs a deletion/tombstone reference;
a pointer to the remote parent would name the winner instead of the loser.
Conflict activity is quiet and reversible, never a modal prerequisite to syncing
unrelated paths.

## Retention is conditional, not an extra write on every pass

Use archival retention for observations that an ordinary content write does not
already preserve exactly. A pure pull has no authored input to archive. A normal
push that already retains the exact observation should not perform a duplicate
retention round trip. A clean/no-op pass must not upload identical content.

The acceptance chain orders backup acknowledgements. It must not be substituted
for the provisional winner policy merely because an old archive uploads late.
If a future confirmed policy needs per-path accepted authored ordering, its
relationship to archival order must be decided explicitly.

## Validation and remaining implementation

Draft backup accepts invalid authored content; validation controls installation
and deliberate publication. Enabled installed skills keep the last valid version
of each skill. ADR-0026 records the separate live filesystem/safety decision
required by ADR-0012; its per-skill adapter implementation and proof are still in
progress.

At acceptance of this ADR, local chronological history, diff3 merging, structured
syntax protection, retained-revision endpoints, acceptance/current pointers and
migration/readback tests exist. Bound-workspace true-merge archival upload and
automatic resolution provenance are now implemented. Invalid Draft transport now
records content diagnostics without blocking backup while publication stays
strict. Older-observation archival upload, restore and activity presentation, live
installation, foreground watch, durable workspace-scoped bindings, guarded
replacement, retention and real-server/Linux recovery proof remain in progress.
This decision is not a claim that unattended sync is ready to ship.
