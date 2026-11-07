# Promote Live Author Workspaces Per Skill

Status: accepted implementation direction. This records the explicit live
filesystem adapter and safety contract required by ADR-0012. Implementation and
verification follow this decision; this document does not claim they are done.

## Separate backup from installation

An Author Workspace is the editable folder on one device, identified as
`authored:<workspace-id>`. It is not an ordinary `local:<path>` snapshot Source.
Draft synchronization and chronological author history retain authored content,
including invalid content (ADR-0025). Installation independently follows valid
skills. A network error must not prevent a valid local edit from reaching an
already enabled installed skill, and an installation failure must not undo a
successful Draft backup.

Reuse the existing Library Collection, Skill Version, Binding, Custody and
Ownership Marker machinery. Do not build another installation or synchronization
engine. Live refresh is a new adapter into the existing immutable retention and
reconciliation boundaries. Ordinary `skit update` for an Author Workspace must use
the same per-skill rules as the foreground watcher.

## Registration and folder ownership

Connection may establish the existing ignored, device-local `.skit/workspace.json`
identity and a self-ignoring `.skit/.gitignore` containing `*`, so the control
directory stays out of the author's Git status without editing root ignore rules.
It must not create `skit.json` in
a plain human-owned skills folder, rewrite authored content, edit root Git ignore
rules, touch `.git`, commit or push. Explicit restore is the separate operation
allowed to replace authored content after preserving its current state.

Moving the folder preserves its workspace identity; copied live metadata is
rejected under ADR-0012. A fresh clone receives a distinct identity. Registration is
separate from content import: a folder with no valid skills may be connected and
backed up while it waits for its first installable member.

*Amended 2026-11-07:* `workspace.json` no longer stores a registration or removal
marker. A workspace is registered while the Library retains its Collection; removal
is a Library operation that leaves the workspace's identity alone, and the next
`author init` imports it again. Automatic refresh still never imports: only
`author init` does.

No new Binding is created by observing a folder. Existing enable/disable intent
remains authoritative. An enabled Collection follows its Source, so new valid
members become enabled without another prompt. New invalid members stay absent
from installations until they pass the existing policy.

## The validation unit is a skill and its complete inputs

Each candidate includes its primary file, declared metadata, supporting files and
shared inputs needed to materialize that skill. Validate a stable captured tree,
not a mixture of files read at different times. Run the same content, invocation,
path, security and harness requirements used by ordinary Library installation;
syntactic frontmatter success alone is insufficient.

For each member independently:

- If the candidate passes, retain and select its immutable installable version.
- If it fails and a previous valid selection exists, keep exactly that version.
- If it fails with no previous valid selection, do not install it.
- Report a read or validation problem without stopping unrelated members.

Unreadable roots pause refresh; they never imply an empty Collection. A malformed
root descriptor freezes membership/declaration changes but does not prevent
known members from advancing using their last valid declarations and newly valid
captured inputs. A plain folder without a collection descriptor discovers skill
directories deterministically and synthesizes descriptor metadata only in SKIT's
staging/retained storage. Never install inputs that were absent from the captured
and preserved author observation. The backup/ignore/symlink scope differences
identified in ADR-0025 remain required pre-watch hardening.

## Plain-folder discovery

Without an explicit collection descriptor, inspect immediate child directories
only. A member is a non-hidden, non-ignored child whose own root contains
`SKILL.md`. Do not recursively search assets, docs or nested containers. Exclude
control directories including `.git` and `.skit`, and never follow a symlink to
expand membership. A root containing `SKILL.md` is a single-skill input, handled
by the existing single-skill acquisition path rather than this collection rule.

The child directory's relative path is its stable logical member path. Its folder
name is the descriptor member name and must satisfy existing name validation;
frontmatter remains authored metadata and does not change that identity. Do not
slugify an invalid folder name into another member's name. If frontmatter names
collide, or folder names collide under case-insensitive comparison, block every
candidate in the ambiguous group and report the paths. Keep any prior selections
for that group; do not pick the newest candidate. Unrelated members may advance.

A folder rename is addition plus removal, not an identity-preserving move. Its
old Binding follows the normal removal rule and its new member follows enabled
Collection intent; an individual Binding is not silently transferred. A missing
`SKILL.md` in a previously known directory holds the last-valid member as invalid
content rather than proving that its directory was removed.

## Promoted Collection Versions are compositions

A single immutable Collection Version still describes the Library's current
selection. It can combine new valid members with last-valid members from older
author observations. It is therefore a derived installable composition, not a
claim that the whole human-owned tree was valid at one instant. Raw observations
remain in author history and Drafts. Never publish this composition automatically.

Materialize the composition in private staging before calling the existing
`importAuthoredCollection` retention boundary. Its source identity and locator
still name the real workspace; only the immutable bytes come from the prepared
composition. Keep logical member paths/names stable so existing Skill IDs and
Bindings survive promotion. Add explicit composition provenance linking selected
members to their source observation/retained input hashes. Portable artifacts must
not acquire absolute workspace paths or device-local workspace identity.

Shared dependencies are part of each selected member's exact version. Suppose A
is blocked and holds shared file v1 while B advances using v2. One common staging
path cannot represent both. Isolate each member's shared input closure in stable,
collision-free staging paths and rewrite the derived descriptor's input mappings
without changing their installed destinations. Do not make A consume B's current
shared bytes. The resulting installed artifact hash must equal the chosen member's
validated artifact hash. Preserve unchanged members' original input provenance;
an invalid save must not mint another Collection Version merely by changing an
observation timestamp or sequence.

This chooses composition over whole-Collection gating. It avoids a new portable
Collection Version model while making the retained staging bytes sufficient to
reproduce every selected installation. If the existing importer cannot express
that truthfully, extend its checked contract at the retention boundary rather
than falsely labelling a partial raw source tree as validated.

## Composition storage and retention

Authored compositions are device-local. The authored-workspace profile remains
`portable: false` under ADR-0012: Library sync must not upload composition manifests
or bytes. Drafts back up raw authored observations; each device derives its own
installable composition. A copied composition is never a second source of truth.

Today's `importAuthoredCollection` writes a whole retained tree per Collection
Version. That is unsuitable for a version per valid save. Before enabling live
promotion, extend the retained-storage boundary for local compositions to store
immutable per-file content-addressed blobs plus small versioned tree manifests
(paths, content hashes and metadata). One changed `SKILL.md` stores its new bytes
and a manifest, not another full collection copy. Existing whole-tree versions
remain readable. The importer/materializer owns format decoding and private
read-only tree materialization so callers still select an immutable version.
Shared blobs must never be exposed to mutable installed or authored folders;
replacement cannot mutate another version's bytes. This changes local retention,
not the portable Collection Version identity or the Draft transport.

Superseded compositions are collectable only after no Collection current
selection, Binding, Installed Skill, recovery operation or active materialization
references them. Pin each member's last-valid closure even if its latest authored
input is invalid. Garbage collection traces manifests to blobs and removes a blob
only when no retained manifest or pending operation references it. Composition
collection does not prune chronological raw author history or Draft revisions;
those have their own retention policy. Interrupted import/collection must preserve
all published references, and reclamation must be proven before continuous use.

## Ownership, ordering and replacement

```text
Before
manual Author Workspace update
└─ Library writer → validate whole live root → import whole root → reconcile
Draft sync → authored working tree and remote only

After
foreground watch / ordinary Author Workspace update
└─ exclusive workspace coordinator (shared by manual commands)
   ├─ inventory authority → shared removal/pause decisions for both passes
   ├─ Draft backup (without Library writer)
   └─ refreshAuthorWorkspace → existing Library writer
      ├─ capture and preserve latest stable workspace observation
      ├─ assess candidates and choose each valid/last-valid input closure
      ├─ prepare deterministic validated composition
      ├─ importAuthoredCollection with real workspace identity/locator
      └─ existing reconciliation for enabled Bindings and Ownership Markers
Draft backup and promotion have independent outcomes within the same coordinator
```

The workflow owns per-skill choice, composition and provenance. Callers request a
refresh and receive outcomes; they do not assign selected versions or assemble
shared-input copies. Capture the latest source under the writer when a queued
refresh runs, so an older queued scan cannot overtake a newer promotion. Never
hold a Library writer while debouncing, sleeping, authenticating or contacting the
Registry. Stable scans retry a bounded number of times; a busy editor is retried
by the next pass rather than blocking the loop indefinitely.

Installed folders remain independent copies. Use the existing filesystem adapter
and ownership/custody checks; never replace a user/agent edit merely because a
workspace changed. Keep displaced/changed bytes recoverable, report that member,
and continue others. Explicit import/restore/copy-back is a separate user action;
there is no automatic write-back to the Author Workspace.

## Removal is a positive observation

A missing primary file for a still-declared skill is invalid content, so keep its
last-valid version. A membership removal requires a readable authoritative
inventory: either a valid descriptor removed the declaration or a readable plain
folder inventory no longer contains that member.

One workspace inventory owner assesses authority for both Draft push and local
promotion. It retains the accepted inventory baseline, pending disappearance
observations and explicit allowances; merely recording a raw history observation
does not approve a smaller baseline. Both paths consume that decision instead of
inferring deletion separately. Unreadable or transiently empty roots and bulk
disappearance pause both paths. Invalid content remains eligible for Draft backup;
a malformed descriptor alone freezes membership, rather than blocking raw backup.
The current file-count Draft guard is the first safety increment, not yet this
shared inventory owner.

For non-bulk removal, use a ten-second grace period with at least two stable
authoritative observations before transmitting removal or retiring a followed
member. Pending removal holds the removed paths and last-valid selections while
unrelated safe changes may progress. Measure the interval monotonically and reset
pending removals after restart or loss of readable inventory. This prevents a
transient editor rename or missing mount from becoming deletion. Preserve the
removed content in history. Existing individual/pinned Binding intent remains
subject to the ordinary Library policy; the watcher must not silently disable it.

Bulk means all known files or all known members disappearing, more than five
known files and more than half of them disappearing, or more than five known
members and more than half of them disappearing. The shared decision uses the
union of file and member checks: neither backup nor installation can bypass a
pause by looking only at its own count. Bulk removal needs an explicit allowance
for the exact captured inventory; ten seconds, repeated scans or restart never
authorize it. A later changed inventory needs a new allowance. Keep last-valid
installations and remote content while paused, and report counts and the affected
paths. A stable branch switch or long cloud eviction therefore does not age into
mass deletion. Content-placeholder detection beyond missing paths remains a
separate requirement; zero-byte replacements are not caught by a count threshold.

## Foreground lifecycle and proof

One exclusive per-workspace coordinator owns both Draft binding mutation and
promotion sequencing. A watcher and manual `author sync`/`update` must join that
owner or wait for it; they cannot run either pass concurrently for the same
workspace. Lock acquisition and crash recovery must work across processes. Lock
order is workspace coordinator before Library writer, never the reverse. Only the
workspace owner may span a network wait; the Library writer must be released.
For a future automatic loop, network attempts must be bounded and a failed
backup must still allow local promotion. The current manual sync has no retry
schedule and holds its lease for the command. The earlier requirement to release
and retake during retry sleeps is superseded; introduce that lifecycle only with
a retry schedule.
Unrelated workspaces remain independent except for existing Library mutation
serialization. This is a required pre-watch rule, not implemented by the current
Library writer alone.

The foreground runtime will own Effect scopes, filesystem events, debounce,
coalescing, periodic/start/wake rescans and narrowly classified retries. Events
are hints; rescan is authoritative. Local promotion continues offline, and Draft
changes applied locally trigger the same promotion path. Persistent login startup
and its UX remain held separately; they are not part of this adapter decision.

Before calling live installation complete, prove at the real workflow boundary:

- One invalid skill retains its exact previous bytes while another valid skill
  advances, without a user prompt or successful network access.
- Shared input changes do not leak into a held member; independent closures with
  different shared versions reproduce their selected artifact hashes.
- A new valid member follows an enabled Collection; an invalid new member is not
  installed; disable remains respected, and a removed Collection is not imported
  again except by `author init` (amended 2026-11-07).
- Plain-folder registration does not create authored config or touch Git, moving
  retains identity, and copying live metadata is detected.
- Root unreadability, malformed membership, transient missing files and restart
  cannot trigger early removal; confirmed removal honors the grace period and
  keeps recovery bytes.
- Installation-side edits survive, unrelated members progress, and rerunning an
  unchanged pass creates no versions or feedback loop.
- Editing one file retains only its changed blob and manifest, compositions stay
  absent from Library sync, and collection preserves every referenced or last-valid
  closure while reclaiming unreferenced superseded compositions.
- Manual and foreground passes cannot overtake each other on one workspace;
  backup and promotion consume the same authority and bulk-removal decisions.
- Plain discovery excludes non-skill/hidden/ignored/nested paths, rejects ambiguous
  names as a group, and treats a rename as addition plus guarded removal.
- Interruption cannot publish an incomplete composition or lose the last-valid
  selection. Real Linux kill/wake and writer-recovery proof remain mandatory
  before a continuously running watcher is ready to ship.

## Lock mechanism (amended 2026-11-07)

A workspace lease uses an exclusive SQLite transaction, with no busy wait, on
`.skit/lock.sqlite`. The shared home lock uses the same mechanism. SQLite supplies
an OS lock without a native addon or timestamp-based stale-lock guesses; process
exit, including SIGKILL, releases it. The lock files contain no application data
and are never unlinked. Reads and previews do not acquire workspace ownership.

Take the workspace lease before short home-lock writes and the Library writer.
Only the workspace lease spans network waits. Built-in edits take that lease;
external editors do not, so a filesystem check cannot exclude an editor save
between the check and replacement. Only observed edits can be recovered from
history.
