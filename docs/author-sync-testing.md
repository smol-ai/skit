# Testing automatic author sync

This is the first test-harness increment for automatic multi-device author sync.
It exercises the existing, unexposed author-sync workflow and fixes its stale
merge base after an accepted write's response disappears. It does not enable a
watcher, expose new CLI commands, or establish that automatic sync is safe to ship.

The next local increment records unvalidated author versions and checks for edits
again after a remote commit. It fixes the two data-loss scenarios originally
demonstrated by this harness. These versions are device-local, not Registry Draft
Revisions or validated Library Collection Versions.

## Ownership

Compared with `1de8931b9`, existing `sync.test.ts` cases keep their focused command
and first-sync checks. The new harness adds shared lifecycle and protocol owners:

```text
Existing focused tests
└─ syncDraft
   └─ each test constructs its own HTTP responses and remote state

New scenario tests
├─ makeAuthorSyncWorld
│  ├─ owns separate device homes and real workspace directories
│  ├─ owns each device's restartable runtime scope
│  └─ invokes the real syncDraft through an explicit RegistryHttp layer
├─ makeAuthorSyncServer
│  ├─ owns Draft request decoding and response encoding
│  ├─ owns accepted revisions and atomic expected-revision checks
│  └─ owns partitions, request gates, lost responses, and unused-fault checks
└─ missingAuthorVersions
   └─ independently compares editor input with bytes readable from copies
```

The caller chooses an edit or a failure boundary. It does not coordinate remote
revision numbers, synchronization state files, temporary directories, or cleanup.
The test server is intentionally one collection, `swyx/tools`; it is not a reusable
Registry implementation.

## What the first increment proves

`packages/cli/test/author-sync-world.test.ts` runs the real Draft client against
the controllable wire-level server, with separate real workspace and home paths:

- Independent offline edits merge and become readable on both devices.
- After an accepted write's response disappears, the next applied sync records
  the agreed remote version as its merge base without repeating the commit. A
  later edit from the other device then merges instead of falsely conflicting.
  A clean preview leaves the ancestry file unchanged.
- The fixture accepts only one of two requests prepared against one revision.
  The client reports the rejection; the test explicitly invokes sync again to
  re-read and merge without losing either independent edit. This does not prove
  the real server's D1 concurrency behavior or automatic client retry.
- Closing one runtime after the server commit interrupts its pending request,
  leaves the server and other device alive, and permits recovery.
- The oracle detects removed or corrupted remote bytes, even while the workspace
  still holds the content. It compares bytes, not production content hashes.
- A scheduled fault that never reaches its boundary fails the test on cleanup.

The sequential property executes bounded sequences of edits, disconnections and
reconnections, synchronizing every edit before the next one. The offline-batch
property keeps both devices disconnected through several observed edits, requires
all versions in local history before any upload succeeds, then reconnects and
checks convergence on independent paths. Neither explores arbitrary conflicting
concurrent histories. Expected current content comes from editor input, not the
production merger. Each evaluation, including shrinking, creates a fresh world. The separate
interruption scenario closes a device scope while its request is pending after
the remote commit. Closing an idle scope around this one-shot client would not
prove a restart property, so the generated sequence does not include idle resets.

## Local version preservation

### Chronological history ownership

Chronological history is required. The change from `72b983fc7` separates stored
trees from their observations without changing the existing version format:

```text
Before
saveAuthorVersion
├─ read stable tree
└─ publish a content-addressed document, or reuse its first recording
loadAuthorVersions → unique trees in hash order

After
saveAuthorVersion
├─ prepare private storage and workspace identity
└─ recordAuthorObservation → SQLite BEGIN IMMEDIATE
   ├─ resolve stable workspace journal and read its last event
   ├─ observe → read stable tree and publish/reuse verified content
   └─ suppress unchanged content or append the next event
loadAuthorHistory → per-workspace events in sequence order
loadAuthorVersion → verify/read only the requested content
loadAuthorVersions → existing access to unique trees, including pre-journal ones
```

`history-journal.ts` owns ordering, workspace aliases and unchanged-scan
suppression. `history.ts` owns stable scans and immutable content publication;
persisted schemas and failures live in `history-contracts.ts`. Callers still
request a recording; they do not assign
sequence numbers or coordinate events with content publication. Event sequence
is a device-local observation order, not a global multi-device order. Timestamps
are descriptive and never decide order. Existing unique versions have no invented
chronology; recording the current workspace starts its journal.

Effect's installed `EventJournal` provides memory/IndexedDB backends, with SQL
through `SqlEventJournal`. Its SQL reader orders by timestamp; that does not meet
the requirement that equal or reversed clocks preserve observation order.
The journal instead uses `@effect/sql-sqlite-node` 4.0.3 and Effect `SqlClient`'s
transactions, with a per-workspace integer sequence. It adds one dependency,
backed by Node's built-in SQLite rather than a native third-party addon.

The transaction starts before the tree is read. Serializing only appends would
let an unchanged scan overtake an older recording that has not committed yet.
The complete read-observe-append operation is therefore serialized, including
unchanged scans. SQLite coordinates separate processes; an Effect `Semaphore`
also serializes this process's writers. Native busy waits are disabled; scoped
connection attempts retry only LockTimeoutError, at 25 ms spacing for at most
200 retries. Each failed connection closes and releases its permit before the
delay. Exhaustion returns retryable AuthorHistoryBusy, not AuthorHistoryInvalid.
The bound counts retries; it is not a deadline for scanning or filesystem I/O.

Compared with `d329471a57de821db416142a2082f35d578f973c`, the history module owns
stable reads, immutable storage, verification, and read access:

```text
Before
syncDraft
├─ validate live workspace, then read live files
├─ send files to Registry
└─ overwrite workspace from staging after response

After
syncDraft
├─ saveAuthorVersion → stable, unvalidated tree in local history
├─ validate and read workspace
├─ saveAuthorVersion and check source before sending a merge
├─ send files to Registry and save accepted revision with pre-application files
├─ saveAuthorVersion and check source again after remote commit
├─ apply only changed files when the source still matches the plan
├─ save applied ancestry before any post-apply history failure can occur
└─ record the resulting workspace before acknowledging the applied update

history.ts
├─ reads verbatim trees twice; retries changed scans at most twice
├─ owns private, content-addressed version files and exclusive publication
├─ flushes file contents and containing directories before returning
└─ loadAuthorVersions decodes and verifies actual version bytes
```

Applied sync records a version before skill validation or network access. If
history recording fails, sync stops. Previews do not record versions. A pass
that notices an edit while waiting for a remote write records the newly observed
tree and fails with `LocalFilesChangedDuringSync`, without applying the stale
plan locally. The remote commit remains accepted; this is not a rollback.
Sync also records its own applied remote updates and first-sync metadata writes.
An integration test drives A → B → A through the actual sync client and checks
all three observations, without an extra manual history scan between updates.

The two former `known gap:` tests now require both versions in **local history**:

1. An edit made during upload remains in the workspace, and both old and new
   versions can be read from history after stale local application is refused.
2. Distinct versions observed during offline sync attempts remain readable after
   reconnecting, even though the earlier version is no longer in the workspace.

The observer boundary matters: edits that happen between sync attempts and are
never read are not recorded. There is no background watcher yet. A version is a
distinct tree, while an event records an observation. A → B → A creates three
events referencing two stored versions; repeated unchanged scans append no event.
Each event carries device identity, workspace/root provenance, a sequence and
observation time. Sequence decides order. Existing machine identity is reused;
if absent, the existing machine-settings owner creates it in SKIT's home, without
writing metadata into the author workspace.

Versions live in `<SKIT_HOME>/author-history/<hash>.json`. Tree content, root and
optional workspace ID determine the hash; the first recording time does not.
Malformed device-local workspace metadata falls back to root provenance so it
cannot prevent backing up authored files; history does not repair that metadata.
The existing verbatim tree format preserves files, directories, executable bits
and symlinks, without following links. Existing Git/control exclusions and
`.gitignore` still apply. The entire tree is stored in each distinct version;
per-file blob deduplication, retention/pruning, public restore commands and
off-device backup remain future work. The local-history reader verifies hashes
and refuses corrupt existing versions rather than silently replacing them.

Chronological metadata lives in `<SKIT_HOME>/author-history/journal.sqlite`,
partitioned and indexed by workspace. Workspace aliases retain one sequence when
a previously plain folder gains a workspace ID, and when an identified folder
moves. The event table is append-only through the application API; alias rows
may update identity/location metadata. SQLite's transaction commits use
`synchronous=FULL`; complete tree files are flushed before an event can reference
them. The containing directory is flushed before recording is acknowledged.
An interrupted transaction may leave an unreferenced complete tree, but no
committed event pointing at incomplete bytes. Retry after a lost acknowledgement
does not append a duplicate unchanged event.

`loadAuthorHistory` reads only a workspace's event metadata and verifies sequence
and content presence. `loadAuthorVersion` verifies and decodes one selected tree.
`loadAuthorVersions` retains access to old unique trees. Pre-journal trees have no
fabricated chronology; a fresh observation starts the sequence. No stored field
in the existing version format was renamed or repurposed.

The atomic-write helpers were considered, but they do not flush file contents.
History instead uses Effect's scoped temporary directory, `File.writeAll`,
`File.sync`, and exclusive `FileSystem.link`; no generic storage utility is added.
File and directory flushing use the Node filesystem adapter on POSIX. Filesystem
and power-loss durability still require real-process and real-storage proof.

Bound-workspace same-file overlaps now converge under the explicit provisional
later-sync-wins policy, with resolution provenance and retained inputs. A late
unbound device with different files still returns `unbound_conflict` without
changing its input. Automatic bootstrap remains a separate unfinished acceptance
requirement; the bound-workspace proofs do not establish it.

## Effect APIs and evidence

The APIs were checked against installed `effect` and `@effect/vitest` 4.0.3:

- `it.effect` and `it.effect.prop` own per-case test scopes.
- `Arbitrary.schema` and `Arbitrary.array` generate and shrink operation traces;
  replay tokens reproduce their failures.
- `Scope`, `Ref`, `Effect.forkIn`, and `Fiber.join` give each device an independent
  runtime lifetime, so pending work can be interrupted without closing another
  device or deleting its files.
- `Deferred` signals arrival at a request boundary and explicitly releases it.
- `Ref.modify` provides the test server's synchronous compare-and-swap commit.

Effect supplies `Schedule` and `TestClock` for the eventual production scheduler.
The harness does not wrap the one-shot client in a test-only retry loop and then
claim to have tested SKIT's scheduling or reconnect policy.

No custom scheduler, property framework, fake filesystem, or global fetch patch
is introduced. The Effect SQLite adapter is the new dependency. The corpus
examples informing this design:

- [Effect property tests, pinned at 3b28bf686](https://github.com/Effect-TS/effect/blob/3b28bf686bf26e9700edd39c025aff2744dc5303/packages/vitest/test/index.test.ts).
- [effect-agent persistence gates and recovery, pinned at f6483e6ab](https://github.com/yielded-dev/agent/blob/f6483e6aba6a7c06f146fa656a23e59c1d511b43/packages/testing/test/durable-runtime.test.ts).
- [t3code transport injection, pinned at 3f9448747](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/infra/relay/src/hooks/HookForwarder.test.ts).
- [Effect SQLite transaction implementation, pinned at 3b28bf686](https://github.com/Effect-TS/effect/blob/3b28bf686bf26e9700edd39c025aff2744dc5303/packages/sql/sqlite-node/src/SqliteClient.ts), checked against the installed 4.0.3 adapter.

## Running and replaying

```sh
cd packages/cli
pnpm exec vitest run --config vitest.unit.config.ts test/author-sync-world.test.ts
pnpm exec vitest run --config vitest.unit.config.ts test/author-history.test.ts test/author-history-journal.test.ts
# Compile the real-process fixture, then run only its subprocess tests:
pnpm build
pnpm exec vitest run --config vitest.subprocess.config.ts test/author-history-process.test.ts
```

The sequential property uses seed `author-sync-sequential-v1` and 20 runs; the
offline-batch property uses `author-sync-offline-batches-v1` and 10 runs. Vitest
reports the shrunk operation sequence and a replay token on failure. To reproduce
it, temporarily replace that property's `arbitrary` options with
`{ replay: '<reported token>' }`. Keep a concrete regression scenario for a fixed
defect rather than relying only on its random seed. Generated inputs are immutable;
the oracle records the UTF-8 bytes an editor actually writes, including JavaScript
strings containing lone surrogate code units.

## Proof still required

The remote is a protocol model. It decodes the actual request schemas and encodes
responses, but does not implement server authorization, bundle validation,
D1/R2 persistence, public history/restore APIs, or retention. Reading its accepted
revisions is not proof of fresh-device recovery through a production restore API.
Run the eventual server contract scenarios against production migrations too.

The oracle currently checks file bytes at their recorded paths. It does not yet
model rename provenance, deletion records, executable bits, symlinks, installed
skills, or retention eligibility. Separate history tests cover executable modes,
binary bytes and symlinks, invalid content, previews, competing recordings,
changing scans, corruption and storage failures. Its `anywhere` requirement includes connected
workspaces, including the editing device's own workspace; it can pass without
any backup. Its `local-history` requirement accepts only verified local history
files, and its `remote` requirement accepts only retained remote revisions.
The editor-input ledger itself never counts as a recoverable copy.

Closing an Effect scope runs finalizers. It is cancellation, not an abrupt process
crash or power failure. The chronological-journal subprocess tests additionally
run independent recorders against one journal and use SIGKILL while an observation
transaction is pending, then verify a fresh process resumes its sequence. This
proves that particular real-process recovery boundary, not power-loss durability
or recovery of a daemon's partly applied workspace writes. Later increments still
need daemon replacement-journal recovery, real-server tests, and VM
startup/watcher/wake scenarios.
Deterministic gates explore named storage/network boundaries, not every possible
fiber interleaving. A passing baseline suite is not an exhaustive model check.
The fixture's revision IDs are opaque labels to the client; their generated
sequence is not a production ordering guarantee.

The post-commit source check fixes edits made during the network operation; it
does not make the subsequent sequence of filesystem writes transactional. A new
edit after the last check can still race application. Guarded/journaled file
replacement and abrupt-process crash recovery remain required before promising
safe continuous synchronization with arbitrary external editors.

### Review recovery increment (from b6234d080)

Before:

```text
recordAuthorObservation → scoped SQLite (5s native busy wait)
└─ transaction → schema setup, deterministic path alias, scan, append
syncDraft → remote commit → source check/application → history → binding
```

After:

```text
recordAuthorObservation → bounded Effect retry of a scoped, nonblocking connection
└─ transaction → explicit schema boundary, opaque alias/copy guard, scan, append
syncDraft → remote commit → persist accepted revision and pre-application files
├─ source check/application → persist applied binding → history
└─ next pass → reconcile pending application with newer edits before remote merge
```

The journal retains ownership of ordering, including unchanged scans. Aliases keep
existing keys and events; new keys use random nonces, preserving the stored key
encoding. The sync binding owns accepted-but-unapplied evidence; previews remain
passive. This does not make individual filesystem renames transactional.


The recovery increment adds an optional `pendingLocalFiles` field to existing
sync bindings. Old bindings decode as already applied; no existing fields or
history keys change. After an acknowledged update, the binding records the
accepted files and the local tree observed before application. On the next pass,
the client first merges newer local files against that pending application,
then merges the result against the latest remote revision. This preserves
unapplied remote additions/deletions and sequential local saves. A preview does
not clear pending evidence. Applying the final result clears it before history
recording, so a history failure cannot undo the ancestry checkpoint.

Regressions retry an in-flight edit, retain remote-only additions/deletions while
the remote advances, fail history after application, and interrupt a device
runtime after only the first file is renamed. The last test resumes against a
newer remote edit to that already-applied file. Independent-process tests hold a
real transaction, wait for the second process's retry signal, then release it;
another keeps the transaction held until bounded retries report a structured
busy failure, then proves recording recovers. WAL and SHM permissions are checked
while the transaction is live. Worker messages use a schema-decoded JSON protocol.

The remaining boundary is explicit: remote acceptance followed by a lost response
or interruption before the acceptance checkpoint can still leave ambiguous
ancestry if the workspace changes before retry. The existing lost-response case
proves recovery when files match, not arbitrary changes during an unknown outcome.
Bindings also still use the existing whole-document atomic rename (without a
power-loss fsync guarantee), and local replacement still has a check-to-write
race. Workspace-scoped serialized state, request idempotency/accepted-revision
lookup and guarded local replacement remain required before unattended sync.


### Avoid identical remote revisions (from f253d97e3)

The sync workflow now compares the final merged files with the observed remote
files. When they match, it keeps that remote revision and applies locally without
a PUT. Both paths share staging validation, the pending-application checkpoint,
the source check, replacement, applied binding and history recording. The
checkpoint owner stays in `syncDraft`; the planner's returned changed paths are
left intact and a separate local `changedPaths` includes pending application.

```text
Before: merge → validate → PUT → checkpoint → apply → binding → history
After:  merge → validate → files differ from remote? PUT : reuse observed revision
                        → checkpoint → apply → binding → history
```

A regression interrupts a remote-only pull before application, then resumes
against the unchanged remote. Both passes issue only reads, remote history does
not grow, and additions/deletions still converge. Other recovery and mixed-edit
cases continue through the same application path. This reduces unknown write
outcomes for pulls; pushes still require the previously documented acceptance
and guarded-replacement work.

### Diff3 text merging (from a2c1048c3)

The first conflict-resolution increment replaces equal-line-count merging with
line-token diff3. `planThreeWaySync` continues owning file classification and
conflict reporting; the dependency owns sequence alignment and overlapping hunk
detection. This increment deliberately does not choose an overlapping winner or
claim losing alternatives have been backed up remotely.

```text
Before: planThreeWaySync → lineMerge → equal lengths, compare line by line
After:  planThreeWaySync → lineMerge → node-diff3 → merge stable regions or conflict
```

Effect 4.0.3's `Differ` composes value patches; it is not a text three-way merge.
The existing transitive `diff` package supplies two-way diffs and patching.
The pinned MIT-licensed `node-diff3` supplies typed three-way merge regions
without spawning Git or touching `.git`. Adjacent replacements are combined only
when diff alignment confirms no insertion/deletion in that region. UTF-8 decoding
is fatal, NUL-bearing content stays binary, and a UTF-8 BOM is preserved.
Explicit line arrays preserve newline
spelling and final-newline state. Binary/descriptor/delete-modify decisions stay
with the existing planner until the retain-before-resolve increment.

The existing Draft chain orders accepted head updates through parent revision
links. Failed conditional writes insert no revision, reads expose only the head,
and rows do not distinguish authored edits from merges. Therefore the chain
alone currently cannot retain a losing submission or identify an authored change
across automatic merges/retries. The next protocol increment must add retained
alternative readback and provenance before enabling automatic conflict choices;
new edit IDs are justified only where revision identity cannot supply that fact.

### Retained Draft revisions (after 30e457d79)

The revision ID remains the server's identity for retained content. The existing
`parent_revision_id` chain will order server acceptance, including retained
alternatives; a separate history-tip pointer lets retention append without
changing the canonical content head. A causal base revision is recorded separately
from the acceptance parent. Authored writes and automatic merges carry distinct
provenance so copying or merging a file cannot make its edit newer.

```text
Before
Drafts.write → validate → blobs → atomic D1 batch → content head + parent revision
Drafts.read → content head only

After (retention boundary)
Drafts.write/retain → prepare → blobs → atomic D1 batch
├─ parent = previous acceptance tip; advance acceptance tip
├─ write advances content head; retain leaves content head unchanged
└─ immutable caller request identity dedupes retries before accepting another revision
Drafts.readRevision → owned revision metadata + verified blob bytes
Drafts.history → bounded chain metadata; no tree bodies in the listing
```

A retention request key is an idempotency key, not a second edit identity. It
will derive from the already durable local observation; server-assigned Draft
revision IDs and the acceptance-parent chain establish identity and order.
A reused key with different bytes, metadata or causal input is rejected. The
server must validate base ownership and keep every chain append conditional in
one atomic D1 batch; no transaction may span R2 or network work. Existing legacy
revisions remain authored by default and retain their IDs.


The retention boundary is implemented server-side before the client enables any
new winner rule. Migration `0010_draft_history.sql` initializes acceptance tips
from existing content heads, keeps revision IDs and parent links, records causal
bases separately, and labels old provenance `legacy` rather than inventing edit
identity. New authored/merge provenance is explicit. Old callers remain supported.
A merge has no authored changed paths; an authored retention computes changed
paths against its causal base, including deletion and executable/media changes.

`POST /api/skits/:owner/:slug/draft/revisions` retains an authored alternative;
its request key deduplicates identical retries and rejects changed intent.
`GET .../draft/revisions/:revision` reads one owned revision's actual bytes.
`GET .../draft/history` follows acceptance-parent links in pages of at most 100
metadata rows, stopping after the cumulative changed-path JSON reaches 1 MiB
(one final entry may cross the threshold), with `next_cursor` naming the next parent. Capture the first page's
tips for a synchronization pass; later appends do not change the chain reached by
its cursor. Both canonical reads and retained reads share `loadFiles`, which
checks aggregate size, blob size and SHA-256 before returning bytes. All endpoints
require authoring credentials and existing resource authorization; retention uses
the same origin and body-size restrictions as updates. Responses are no-store.

Real local Cloudflare tests cover service retention, idempotency, changed-intent
rejection, concurrent accepted chains, causal-base ownership, merge provenance,
blob corruption, bounded paging during a later append, migration of legacy rows,
and authenticated HTTP through D1/R2. The concurrency case gates two prepared
requests before either real D1 batch executes, then asserts exactly one retry; it
does not infer overlap from launching fibers. Pagination also exercises the
metadata byte budget, rather than relying on the row limit alone. This does not yet connect the client to
retention or change its current conflict status. At that increment Draft content validation still gated storage; the later invalid
Draft transport increment below removes that gate.
No server deployment is implied by these tests.


### Synthesized structured content

A clean line merge is not necessarily valid JSON, YAML or Skill frontmatter.
The planner checks syntax using the result's path/media type. If both authored
inputs parse but the synthesized result does not, it reports the path as an
overlap for the eventual winner policy instead of manufacturing a broken file.
Already-invalid authored inputs remain transportable; this is not an installation
or Draft validation gate. The Skill parser is the existing frontmatter owner.
Tests show duplicate-key YAML/frontmatter fails only the structured check while
exactly the same edits merge as ordinary text, and preserve intentionally invalid
YAML input and valid independent JSON changes.

Line endings are byte-preserving. Switching a file from CRLF to LF can therefore
conflict with another edit across that file; no normalization policy is implied.
Same-point insertion union is a product option, not implemented or presumed.

The proposed simpler late-sync-wins protocol still needs two explicit cases:
unknown acceptance followed by another device's causal descendant, and a local
deletion losing to a remote edit (where the remote parent contains the winner,
not the losing deletion intent). Local history and a no-op PUT check alone do not
resolve either ambiguity. These traces were sent to Claude for design review;
current acceptance/content pointers are retained until their necessity is settled.


Unpinned content writes also retry a failed atomic append when only the history
tip moved. Each attempt rechecks the original expected content head. An explicit
`expected_history_revision_id` remains strict and never silently rebases. Gated
D1 tests cover the tip-only success, pinned-tip conflict, and changed-head refusal.
ADR-0025 names the off-device observed-save guarantee that consumes archival
retention without requiring an extra archival write on every synchronization.

### Prepared-upload recovery (after a63dfa9e4)

Before: PUT → accepted checkpoint → source check/application. A lost response
leaves no accepted checkpoint, so a later causal descendant can appear concurrent.
After: durable prepared files/base/local checkpoint → PUT → accepted checkpoint.
On retry, follow `base_revision_id` from the captured content head, using paged
history metadata. Only a matching prepared bundle on that causal ancestry can
advance the base; an unrelated archival match is insufficient. Replay current
local changes against the accepted prepared files, then merge the latest head.
The state writer owns scoped staging, file fsync, atomic rename and directory
fsync. Whole-document concurrency/workspace scoping remains later hardening.


Regression coverage includes a lost acknowledgement followed by another device's
causal descendant, a newer local edit replayed alongside a later remote addition,
passive preview, an archival sibling with matching bytes that must not count as
accepted, and a prepared-file flush failure that prevents the network write.
The wire fixture now models retained alternatives separately from its canonical
head and serves the real paged metadata contract; real D1 retention behavior stays
covered in the server suite rather than inferred from this fixture.

This closes the bound-workspace unknown-PUT-response case when the accepted
revision remains on readable causal ancestry. It is not full unknown-outcome
recovery for first creation, pruned/unavailable ancestry, or explicit restore/ABA
intent. Prepared state remains part of the existing whole-document binding file;
concurrent writers/workspace scoping and guarded local replacement remain required
hardening. File/directory fsync is implemented but physical power-loss proof is
still part of the later real-storage/VM work.

### Nonblocking bound-workspace merges (after c6899b837)

The pure planner keeps report-only behavior by default and gains an explicit,
replaceable later-sync-wins policy for author sync. It merges stable text hunks,
chooses local authored content for overlapping hunks, and keeps edits over deletes.
Structured synthesis protection falls back to a complete authored file.

```text
Before: planner conflicts → stop
After:  planner → files + resolution facts
        syncDraft → retain exact local input only when both sides changed and final files differ
                  → write resolution provenance on the accepted head, or on retention when no PUT is needed
                  → accepted checkpoint → guarded source check/application
```

Remote and retained-local revision references make choices readable and reversible.
The server owns durable provenance with the accepted revision; a quiet activity
view can read it without making another authored edit. A normal push retaining
its exact local input and a pure pull require no archival round trip.


The bound-workspace increment is implemented across the planner, client and
server. Default planner callers still report conflicts; author sync opts into the
replaceable policy. Server resolution metadata records both input revision IDs,
path decisions and whether they came from pending replay or current-head merging.
References are checked for collection ownership, stored atomically with their
revision and returned by head/revision/history reads. A local deletion losing to
an edit is represented by the retained tree lacking that path; no independent
tombstone store is added. If no content PUT is necessary, its resolution event
lives on that retained revision. If the final tree already equals the authored
local input, the content write preserves it without redundant retention.

Retention and subsequent source checks precede any local replacement. The client
classifies actual local uploads as authored and synthesized merge outputs as
merges. An edit during the retain response is observed and prevents stale
application. History pages now select metadata only, and their byte budget counts
resolution JSON as well as changed-path JSON rather than loading descriptors for
every historical revision.

Focused tests cover local overlap plus independent remote hunks, edit/delete in
both directions, complete-file structured syntax fallback, exact local snapshots
retained on clean merges, no resolution event for non-overlapping text merges,
edit-beats-delete without a duplicate head, and editing during retention. The
`author-sync-overlapping-v1` property runs eight generated traces of one to three
offline rounds. Both devices edit overlapping and independent lines of the same
file, vary insertion and upload order, then converge. The byte oracle requires
all authored inputs in remote history, not just surviving workspace files.

Quiet activity presentation and one-step restore still need a consumer of the
stored resolution provenance. Invalid authored Draft transport, automatic new
workspace bootstrap, the offline archival queue, live per-skill installation,
watch and remaining hardening/proof are not established by this increment.

### Invalid Draft transport (after 354c8e908)

Draft transport separates raw path/encoding/size integrity from descriptor, skill
and installation/publication validity. Descriptor metadata is optional on writes
and nullable on reads when authored descriptor bytes cannot be parsed. The server
always derives metadata from the actual files and returns diagnostics; it never
fabricates a valid descriptor for invalid content. Empty authored trees are
representable. The client may send a parsed descriptor for compatibility, but a
parse failure is not a sync gate. Filesystem read failures remain failures.

```text
Before: syncDraft validates local + staged tree → server validates artifact → store
After:  syncDraft records/reads files + optional descriptor
        → server checks transport integrity → assess artifact into diagnostics → store
Publication continues strict artifact validation; installation keeps its own gates.
```


Invalid transport is now implemented on both sides. The client reads only an
optional descriptor for compatible metadata and never runs artifact/installation
assessment as a sync prerequisite. Missing/malformed declaration errors are
content states; other filesystem errors propagate. The server enforces file
count, uniqueness, base64, path and content-size limits, derives descriptor
metadata from raw files and records assessment errors as diagnostics. Incomplete
skills can retain valid descriptor metadata while malformed descriptors read back
as `null`; empty trees have no fabricated descriptor. `skit_id` independently
identifies the routed Draft. A changed descriptor slug is backed up in the
connected home rather than silently changing remote destination.

This is an explicit Draft-contract relaxation: writes may omit descriptor hints
and files may be empty; valid legacy writes/reads retain their shape, while
reading newly invalid Drafts requires a client supporting nullable descriptor
metadata. Untrusted request shape, unsafe paths, duplicate paths, oversized
content, credentials and origin restrictions remain enforced. Publication's
archive validation is still strict and unchanged in purpose; a real stored
invalid Draft is rejected by `verifyReleaseArchive`.

Tests prove invalid descriptor bytes locally and remotely, a broken Skill merged
with an independent file change, real authenticated invalid-Draft PUT/GET,
invalid alternative retention, empty and incomplete trees, duplicate rejection,
and strict publication refusal. This does not prove last-valid per-skill agent
installation: the live-installation ADR and implementation are still next.

### Shared Draft manifest and unresolved ancestry

Before: client, server and wire fixture each format the Draft manifest separately.
After: core `encodeDraftBundleManifest` owns the existing byte format; client and
server hash those same UTF-8 bytes with their platform crypto adapters. This is
not the Artifact hash-parts format, so that encoder cannot substitute for it.
The client explicitly supplies `executable: false` until executable transport is
implemented; changing that transport must update this value too.

If the causal walk reaches a root before the prepared base, the client reports
an unresolved prepared upload and retains the checkpoint. It must not assume
that the request was never accepted. Retention must protect reachable causal
bases and all entries needed between an outstanding prepared base and the head;
pruning that evidence cannot silently change recovery into a local overwrite.

### Large deletion pause

Permissive Draft storage does not imply automatic permission to empty a connected
workspace. Before retention, upload or local application, the client compares the
current local files with its last observed editor base (the pending local tree
when an accepted revision has not been applied). Removing every known file, or
removing more than five files and more than half the known files, returns
`paused_large_deletion` with deleted, previous and current counts. Preview reports
the same pause. Repeated scans and restarting do not implicitly authorize it.
Local history is still recorded before this decision; no remote write is made.

A deliberate bulk removal can be allowed for one invocation with
`--apply --allow-large-deletion` through the author-sync handler. This is not a
persisted watcher preference. The foreground public watch command is not yet
implemented. The author output contract advances to `skit.author.sync.v4` for the
new paused result, with a rendered explanation and explicit action.

World tests empty A, repeat/preview/restart its paused sync, and prove B and the
remote retain their files. They then explicitly allow the deletion and prove
convergence. A partial-deletion scenario distinguishes a blocked eight-file
removal from a normal five-file removal. This is a file-count safety policy:
zero-byte replacements, cloud placeholder detection and other large content
changes need separate handling; these tests do not claim to recognize them.

### Binding format boundary

Pre-release binding fields from `feat/automatic-author-sync` are not migrated.
They have not shipped or left this branch. The upcoming per-workspace store will
version its persisted format and own the migration from supported released state
once; it will replace inline trees with verified content-addressed references.
Do not add migrations for each intermediate pending/prepared shape in this work.

Unknown or partial pre-release pending evidence must not acquire guessed causal
provenance. The scoped loader must retain recovery bytes and either recover from
verified prepared/ancestor evidence or report the unresolved state. Discarding
untrusted pending metadata is not permission to treat unapplied remote additions
as local deletions. These are loader requirements; that store is not implemented
yet, and the current inline loader still has its intermediate fallback behavior.

### Shared local retained files

Compared with `021751f37`, authored import now selects shared-file retention at
its existing Collection Version boundary:

```text
Before
importAuthoredCollection
└─ writeCollectionVersion → copy whole tree → verify hash → publish tree
installedSkillSource / security / archives → retained tree paths

After
importAuthoredCollection
└─ writeCollectionVersion(storage: shared-files)
   ├─ capture entries → exclusive durable read-only per-file objects
   ├─ link private retained tree → verify original tree hash
   ├─ publish versioned sidecar manifest → publish retained tree
   └─ preserve legacy whole-tree paths/readers
installation / artifact hashing
└─ copyLocalTree(verbatim: false) → independent owner-writable files
```

The retention owner hides file addressing, exclusive publication, verification,
fsync and manifest layout. Callers still receive a verified retained tree path;
they do not coordinate blobs or know whether an older tree used whole-tree
storage. File objects live under `originals/.files/v1/blobs`; manifests under
`originals/.files/v1/manifests` use `skit.collection-files.v1`. File identity
includes normalized executable mode, because hard links share inode permissions.
Private retained paths share read-only files; mutable authored/installed folders
never receive those links. Non-verbatim materialization copies add owner-write
permission without changing executable identity. Verbatim copies retain their
existing permission policy.

Publication fsyncs staged bytes before exclusive link publication, directories
through the store root, and retained tree directory entries before publishing the
tree. Interruption may leave unreferenced immutable blobs, never a published
partial tree. A manifest is published only after its tree hash verifies. Reuse
verifies bytes and existing manifests; corrupted addressed data is not replaced.
Existing whole-tree versions remain readable without conversion. The Library
writer still owns import/state ordering; this change adds no daemon or coordinator.

Disk-level tests prove one changed file adds one blob, unchanged assets share
inodes, executable modes stay distinct, materialized copies remain independently
editable, old versions read unchanged, corrupt manifests fail closed, stale input
cannot publish a manifest at an old address, concurrent blob publication dedupes,
and interrupted tree publication safely retries. Existing authored import and
workspace journeys exercise the real integration. This does not complete
composition selection, reference-traced garbage collection or live installation;
those remain required before continuous promotion is enabled.

### Identity before installable content

Compared with `fb26ac757`, a separate identity-only lifecycle now supports a plain,
invalid or empty readable folder without scaffolding `skit.json` or importing a
Collection. This internal boundary is not yet a new public CLI command.

```text
Before
ensureAuthorWorkspaceRegistered
└─ Library writer → whole-root validation → metadata → import → registered marker
history / journal → workspace lifecycle module for metadata reads

After
ensureAuthorWorkspaceIdentity
└─ Library writer → identity/copy/opt-out plan → ignored pending metadata
   └─ raw history journal (existing ID/root aliases) → registered marker
ensureAuthorWorkspaceRegistered → existing validation/import path (unchanged intent)
history / journal / lifecycle → metadata decoder only
```

The lifecycle owns planning, initial recovery observation and final registration;
callers do not publish metadata or guess whether an invalid root is installable.
The identity-only workflow stays separate from ordinary Library startup so the
SQLite adapter is loaded only by author-history consumers, not by `skit --help`.
Initial metadata and its self-ignore are fsynced before observation; final lifecycle
markers use atomic publication followed by file/control-directory/root fsync.
History already owns move/copy aliases, so no second identity registry is added.
The `.skit/.gitignore` self-ignore is created exclusively; root ignore rules and
Git internals remain unchanged. Missing/unreadable roots fail, rather than being
created as empty workspaces. Removed markers require explicit re-registration.
An invalid first observation may establish identity but creates no Collection,
Collection Version or Binding. The per-skill adapter still needs implementation.

The journal obtains machine identity before its permit/SQLite transaction. It must
not hold a journal writer while asking for the Library writer, because a promotion
can hold the Library writer while recording an observation. An identity failure
is carried until after raw bytes are preserved, then reported without claiming a
successful registration. This preserves recovery while avoiding lock inversion.

Tests cover invalid and empty first connections, repeated deduplication, copied
ID rejection before any Collection exists, moves and reuse of the old path,
removed registration, failed final metadata publication and retry, malformed
machine settings with raw recovery preserved, and a gated independent recorder
competing with a Library writer. A real local Git fixture checks status, index
and `.git` bytes/identities before and after connection, without committing.
Copy remediation explicitly tells the user to remove only the copy's
`.skit/workspace.json` before giving that copy a new identity.

### Filesystem limits and exact undo evidence

Shared retention falls back to verified full-tree storage when the native link
operation reports `EXDEV`, `EPERM`, `ENOTSUP`, `EOPNOTSUPP` or `EMLINK`. Effect
preserves the native errno in `PlatformError.reason.cause`; the decision checks
both the link method and that code. It does not hide unrelated permission/read
failures, I/O errors or content-address collisions. Full-tree fallback flushes
file bytes and directories before publication, and temporary linked trees are
removed before copying. Published immutable blobs remain reusable orphan objects.
An exhausted inode link count uses this same fallback rather than allocating
another blob generation. Correctness remains available, with higher storage use
until collection removes superseded references. A debug diagnostic records the
fallback; this is not a claim that every filesystem can deduplicate bytes.

Tests inject capability failures at blob publication, retained-tree linking and
manifest publication, prove exact retained hashes and cleanup, and prove `EIO`
still fails without publishing a tree. The directory flush walk is bounded even
if a future caller supplies a path outside its expected store ancestor.

### Exact permissions for retained reconstruction

Compared with `457f1d9d1`, the setup-undo integration now reconstructs a private
copy before candidate matching. Its existing recovery fingerprint includes full
file/directory permissions, so inspecting the read-only shared tree directly
would report the original unavailable. Fingerprint checks remain unchanged.

```text
Before
setup undo → fingerprint raw retained directory → verbatim-copy selected source
retention → read-only blobs + normalized content manifest

After
retention → blobs + content manifest + checked original-permission sidecar
setup undo → prepareCollectionMaterialization
             ├─ verify tree and exact permission inventory
             ├─ withCopy → private original-mode fingerprint comparison
             └─ stage → private original-mode copy → existing final fingerprint gate
```

The retention owner records a `skit.collection-permissions.v1` sidecar under
`originals/.files/v1/permissions`. It preserves root/directory/file permission
bits; symlinks keep their literal targets and are never chmod targets. The
sidecar has a content checksum, checked tree hash, exact inventory order/kinds
and executable agreement. Paths used for chmod must match the already walked
retained inventory. Portable artifact identity remains unchanged: it includes
executable intent, not every original filesystem permission. This is original
metadata for one retained snapshot, not a new permissions-only history stream.
Sidecars must be collected/pinned with their retained version.

The core materialization owner decodes and checks that metadata, verifies the
retained tree, constrains member subpaths, copies into independent inodes and
applies recorded permissions. Private scoped staging unlocks its own directories
for cleanup; a path moved into its final location is left untouched by that
finalizer. Undo holds on to the checked reconstruction plan for application and
still verifies the exact original fingerprint before changing live folders.
An originally owner-writable skill remains owner-writable; a preserved original
read-only permission remains intentional recovery evidence.

Legacy whole-tree versions retain verbatim reconstruction. Intermediate shared
versions lacking original-permission metadata report `RetainedPermissionsUnavailable`
rather than inventing permissions. Corrupt sidecars fail closed. Tests cover full
mode restoration (including group write and executable modes), literal symlink
text, cleanup of read-only private directories, independent editable bytes,
published-mode preservation, missing/corrupt metadata and legacy versions. A real
setup-undo test removes the preserved original, reconstructs an authored retained
skill, edits the restored copy and proves shared retained bytes/modes unchanged.
This closes the retained-source undo integration; live promotion and GC remain
separate outstanding work.

Original permission capture retains all permission evidence, but reconstruction
refuses selected setuid, setgid or sticky bits (`0o7000`) before staging. Stripping
them during exact recovery would silently change the fingerprint, so it reports
`RetainedSpecialPermissions` instead. Legacy whole-tree candidates get the same
check. A special-bit entry outside the selected member does not block a healthy
member. Ordinary installed-copy materialization always masks special bits on files
and directories, including the installed-profile undo fallback. Existing verbatim
backup/source retention keeps its metadata policy.

Tests cover reported setuid/setgid/sticky evidence in shared and legacy stores,
unrelated members and the setup-undo report. They also inspect the modes requested
by the ordinary copier. This sandbox clears setid bits on regular files, so setid
policy cases inject the OS metadata seam; they are not proof of privileged-bit
behavior on a real Linux filesystem. The normal permission/copy-isolation tests
continue to use real files. Real Linux lifecycle proof remains outstanding.

### Plain-folder per-skill compositions

Compared with `fbd9b63d2`, `scanPlainAuthorMembers` and
`preparePlainAuthorComposition` implement the plain-folder selection/staging lane:

```text
Before
Author root → whole-root validation/import
plain folder → identity/history only

After
preserved entries + stable Git inventory + previous retained composition
└─ preparePlainAuthorComposition
   ├─ scan immediate members and block ambiguous groups
   ├─ evaluate captured inputs with existing content/security/harness checks
   ├─ choose valid current inputs or exact previous inputs per member
   ├─ hold removals pending shared inventory authority
   └─ deterministic private composition → existing importAuthoredCollection
```

The scanner derives logical identity from the immediate folder name, excludes
hidden/control paths and never follows a symlink. Supplied Git membership excludes
ignored primaries. Folder case collisions and duplicate frontmatter names block
all affected candidates; an invalid name is never slugified. A known directory
with a missing/replaced primary is held, while an absent directory is reported as
pending removal. Discovery is not content validation: malformed content remains a
candidate until the validation layer reports it. A rename is a new path, never
an automatic transfer of an individual Binding.

The composition owner reads captured bytes only, filters supporting inputs with
the same Artifact control-path policy and supplied Git inventory, rejects unsafe
or ambiguous paths before writing, and uses the existing frontmatter, security
and directory validators. It evaluates the supplied harness set; future target
changes still require installation-side compatibility checks. Malformed YAML
frontmatter is blocked even with no active harness. Previous held inputs and
new selected copies are checked against their input hashes. Raw-history recording,
Git-query stability and writer ownership remain the enclosing workflow's job.

The derived descriptor exists only in private staging/retention. A versioned
`.skit-author-composition.json` records selected input and observation hashes,
without absolute paths, workspace IDs or timestamps. Unchanged input origins are
kept, so repeated invalid saves cannot create new Collection Versions. Declared
and single-skill roots are explicitly rejected by this lane; their own adapters
must handle them. Removal remains held here until the shared inventory owner
supplies authority; this code cannot uninstall a disappeared skill.

Real importer tests prove a broken alpha holds exact prior bytes while beta
advances, Skill IDs survive, no-op/invalid passes reuse versions/imports, a new
invalid member stays absent until fixed, and disappearing members remain held.
Other tests cover raw captured-view isolation, controls, real Git exclusion,
symlinks and unsafe paths. This is not yet the public refresh/watch workflow or
proof of enabled-copy reconciliation. Declared shared-closure composition, common
inventory/coordinator/GC and the rest of the active goal remain outstanding.

An existing scope bug was also found during this work: the verbatim walker did
not honor `respectGitIgnore`, although raw author history requests it.
The composition accepts an explicit Git inventory and filters its inputs, but
this did not repair raw-history scope. The following increment repairs that
boundary; continuous history and off-device observation backup remain separate.

# Native Git membership for raw observations

The raw history caller already requests `respectGitIgnore`, but the walker
previously applied it only to normalized trees. The fix belongs in the tree
boundary, rather than filtering a completed history record:

```text
Before
raw history -> verbatim walk -> ignores respectGitIgnore
Artifact walk -> Git membership -> NFC paths -> normalized bytes

After
raw history -> verbatim walk -> Git membership resolved to native entry names
Artifact walk -> Git membership -> NFC paths -> normalized bytes
```

Git may report a precomposed index name for a decomposed macOS directory entry.
Raw membership must resolve that alias without changing the recorded name. An
exact directory name wins; an alternate spelling is accepted only when lstat
proves that the requested and actual names identify the same filesystem entry.
Symlinks are compared without following their targets. Distinct Unicode names on
Linux must remain distinct, including when one is ignored. The existing native
realpath API follows symlinks, so it cannot resolve this membership safely:
directory listings plus the existing lstat identity seam retain lexical link
paths instead. Directory listings are reused only within this scan.

Core tests cover configured global/nested/info excludes, tracked ignored paths,
native Unicode file/directory/link names, and a symlink replacing a tracked
directory. The distinct NFC/NFD-name case is explicitly skipped on a filesystem
that aliases them; its real-filesystem proof remains part of Linux validation.
A history integration test verifies that ignored changes create neither saved
bytes nor a chronological event. Existing immutable records are not rewritten or
pruned by this correction; history recorded before it can still contain ignored
files.

### Shared Author inventory and ignored-credential proof

Draft `readTree` already requested a normalized Git-filtered walk; there was no
general absence of Git filtering in the existing upload path. However, separate
history/transport policies disagreed on controls and normalized Git filenames.
Both now consume `walkAuthorTree`:

```text
Before
history -> verbatim Git-filtered walk (raw control policy)
Draft create/update/retain -> normalized Git-filtered walk (Artifact controls)

After
history / Draft readTree -> walkAuthorTree
  -> one native Git membership + shared Artifact control exclusions
  -> verbatim history, or checked normalized file transport
```

Ignored files are outside the Author inventory, not merely omitted to save disk.
The adapter excludes controls before reading file bytes. History retains native
names, directories, symlinks and executable flags; current Draft encoding remains
file-only and refuses symlinks. Those representational limits remain explicit;
they do not create a second ignore policy. Normalization collisions fail instead
of silently overwriting one file in the transport's path map.

The sync-world regression creates a gitignored `.env` sentinel before the initial
Draft upload, then makes a real two-device merge that retains the local authored
input. It checks actual stored local version bytes and every server revision's
decoded files (including the retained alternative), not just filenames or an
acknowledgement. The sentinel and control files are absent throughout; local
ignored files remain untouched. A core test compares ordinary-file membership in
both representations.

Older history on this unpushed branch may contain ignored files. This correction
does not rewrite or prune those records. They are not inputs to an off-device
queue today; future observation upload must use the filtered inventory rather
than blindly uploading legacy raw records. No released-state migration is needed.

### Why native `check-ignore --stdin` does not replace the resolver yet

A local probe on Apple Git 2.50.1 (Apple Git-155), with the initialized repository's
`core.precomposeunicode=true`, found a tracked-path counterexample:

1. Create native `cafe\u0301.md` (decomposed spelling), then `git add` it. The index
   stores the precomposed spelling `café.md`.
2. Add `*.md` to `.gitignore`.
3. Pass the native decomposed path, NUL-terminated, to
   `git check-ignore --stdin -z --verbose --non-matching`.

The stdin command reports the tracked file as ignored (exit 0). Passing the same
decomposed filename as an argument reports it as nonmatching (exit 1), as does
passing the precomposed index name through stdin. None uses `--no-index`.
Consequently, native stdin alone does not establish tracked-beats-ignored on
this installed Git. The committed tracked Unicode test exercises this case
through the current directory-entry/lstat resolver. This is a local tool-version
observation, not a claim about every Git release or platform.

A detected worktree whose Git query fails already fails closed. A plain folder
without a worktree currently has no Git membership filter, even if it contains
`.gitignore`; that remains an explicit privacy-boundary gap. Resolve it with an
authoritative ignore evaluator or a clear failure, not an approximate pattern
parser or an include-everything fallback. Any batch evaluator must decide scope
before reading ignored file bytes and traversing ignored subtrees.

### Receive-side unrecorded target guard

The outbound ignored-credential proof did not protect existing private bytes from
incoming writes. A new regression reproduced both failures before the fix: after
two devices bind, A adds an unignored `.env` remotely while B's `.git/info/exclude`
hides its own `.env`. B's pull replaced either its private file or its dangling
symlink with A's bytes. B's excluded bytes were never in Author history.

Sync now checks incoming replacements before any retain/upload, and checks again
immediately before each local rename/remove. An existing target outside the
captured local inventory returns `AuthorLocalPathNotObserved` without reading or
replacing it. The check uses lstat, so a dangling symlink is still an existing
target. The regression also includes an unrelated local edit: neither a retained
alternative nor a merged revision is sent before this guard fails. Retry after
runtime restart still preserves the private path.

This is an interim safety guard, not the final per-device ignore view. Different
device rules still stop this sync instead of advancing unrelated paths. Next,
remove locally excluded paths from the three merge inputs, carry their remote
content through uploads unchanged, and track the local merge base separately
from the complete remote bundle. Changes to ignore rules must enter/leave that
view without minting remote deletions. Re-check target ownership at the write
boundary as defence in depth. The original leaf-only guard still allowed parent
symlinks to redirect new writes outside the workspace. The ancestor check below
closes that static case; the remaining check-to-write race still requires guarded
replacement. This preflight is not an atomic filesystem guarantee.

### Scoped process input for plain-folder ignore evaluation

A private bare-repository probe successfully evaluated root/nested ignore rules,
negation and decomposed names with `--no-index`, explicit
`core.precomposeunicode=false`, and an external `--git-dir`/`--work-tree`. It
created no control files in the human folder. This is a no-index probe, not a
replacement for tracked-file handling in real worktrees.

The installed Effect 4.0.3 `ChildProcess.make` accepts a byte Stream as stdin,
closes it at EOF, and owns its lifetime in the spawned child scope. SourceProcess
now exposes that existing capability as optional `stdin`; it adds no custom
input pump or retry. Existing output budgets, stderr draining, timeout and scoped
child cleanup still own the whole operation. Input bytes are not included in the
invocation string. Tests prove binary chunk fidelity through real stdin/stdout,
EOF plus non-zero status, and finalization of a pending producer when the caller
interrupts the child operation.

The privacy gap for a folder without a worktree is not fixed by exposing stdin.
The subsequent evaluator must filter names before file reads or descent, fail
closed on query errors, and share the Author inventory boundary. Persistent
private-repository ownership belongs with the workspace coordinator; the core
tree walker must not infer a SKIT home or mutate the human folder to get Git
semantics. The proposed built-in credential denylist is a separate product choice
and is not implemented here.

### Chosen evaluator for Author folders without Git repositories

The shared Author inventory now uses a scoped private bare repository with
`check-ignore --no-index --stdin -z` and explicitly pinned
`core.precomposeunicode=false`. Git evaluates the human root via `--work-tree`
and `-C`; no `.git`, index or config is written in that root. Actual worktrees
keep their existing tracked-file-aware native mapping. The private evaluator
never replaces that mapping.

```text
Before (bbb4100e2)
walkAuthorTree -> native worktree inventory, or unfiltered plain folder

After
walkAuthorTree -> native worktree inventory, or scoped plain Author evaluator
  -> each directory's native names -> Git ignore query -> read included bytes
```

The evaluator owns private-repository lifetime and strict query-result checks;
the walker owns traversal and shared control exclusions. It batches names per
directory before reading file bytes or entering children. Git handles negation
and global/nested rules; SKIT parses only the NUL-delimited list of ignored native
paths. Exit 0/1, complete delimiters, requested paths and uniqueness are checked.
An error or malformed/partial result fails the whole observation closed.

If spawning Git reports NotFound, a directory with `.gitignore` fails before its
files are read. Without any such rules, plain content remains available. Other
Git initialization failures and failures after initialization always fail closed.
The fallback applies only to Author inventory; ordinary Artifact walk contracts
are unchanged.

Core tests cover nested/negated/native names, configured global excludes, no
reads or descent for excluded paths, private-repository cleanup, missing Git with
and without rules, and failed or malformed batch output. The existing upload/
retain `.env` sentinel test now runs for real repositories and plain folders.
The initial private repository was scoped to each scan. That avoided guessed
SKIT-home authority, but repeated initialization and directory queries later
exceeded the generated recovery tests' existing timeout. The following change
fixes that cost without weakening their case counts or timeout.

### Reuse only immutable Git context, never file membership

```text
Before (641dd4f81)
each Author scan -> private git init
                 -> check-ignore child for every directory

After
SkitServices runtime -> AuthorIgnoreRepository -> ScopedCache (one empty repo)
each Author scan -> fresh Git file listing
                 -> check-ignore only for unknown/empty directory membership
                 -> read included bytes
```

The installed Effect 4.0.3 `ScopedCache.makeWith` owns private-repository lifetime
and concurrent acquisition. Its one immutable success is retained for the runtime
scope; failures have zero TTL and can be retried. Lookup-time services preserve
explicit platform injection. Only Author walking needs this service; ordinary
Artifact tree dependencies remain unchanged. The repository is initialized
lazily, so CLI help does not allocate it. Normal scope closure removes it. This
is process-scoped temp state, not a new persistent SKIT-home store or workspace
sync coordinator.

Every scan runs a fresh `ls-files --others --exclude-standard -z` under the private
context. Native files and their parent directories establish known membership.
Unlisted leaf files stay excluded; unknown directories still use the no-index
ignore query before descent, preserving non-ignored empty directories. Rule
edits take effect on the next scan; neither file bytes nor ignore decisions are
cached. Unignored embedded repositories fail closed, matching the existing
worktree inventory's unsupported-repository boundary.

A real subprocess probe also showed that inherited `GIT_OBJECT_DIRECTORY`
redirects `git init` writes outside the intended private repo. Private commands
now pin Git directory/common/index/object paths, clear worktree state during
bare initialization, and use only the selected author root for queries. The
SourceProcess wrapper exposes the installed command constructor's `undefined`
environment removal semantics; `setEnv` alone does not type that capability.
Global ignore configuration is preserved. Tests inject outside Git paths and a
corrupt outside index, verify successful evaluation, and verify those paths are
untouched.

Tests cover one initialization across repeated scans with fresh rules, failure
retry, owner-scope cleanup, empty-directory preservation, native Unicode names
and inherited environment isolation. After reuse/batching, the unchanged
generated recovery tests passed with their original timeouts and case counts.

### Separate the device's applied plan from the canonical upload

The next ownership boundary starts by removing an existing conflation in
`sync.ts`: `plan.files` meant both the files applied on this device and the files
sent to the Registry. Those trees differ when a device excludes remote paths.

```text
Before (535901825)
syncDraft -> three-way planner (pending/current)
          -> derives concurrent edits and deletion counts
          -> same plan.files for staging, upload, binding and local writes

After
syncDraft -> planAuthorSync (pending/current)
          -> owns projected inputs, concurrent-edit and deletion facts
          -> visible plan for local writes
          -> uploadFiles for wire/hash/accepted binding and descriptor staging
```

The planner omits current exclusions from every input and previous exclusions
from the device's base, then carries the current remote's excluded files into
`uploadFiles` unchanged. Excluded paths never count toward the local deletion
guard. Becoming visible with no local file is a remote addition; with different
local and remote files it is the normal both-added merge. The pure policy is
tested without pretending that synthetic file maps prove filesystem privacy.

This increment connects that boundary with empty exclusion sets, preserving the
current runtime behavior. Durable exclusion fields, authoritative classification
of absent candidate paths and quiet per-device reporting are not wired yet. The
interim unrecorded-target guard continues to stop the known collision.

The upcoming binding must retain the full accepted bundle and its excluded-path
set; prepared uploads must retain the set that accompanies their bundle as well.
Pending replay starts from the actual pre-application local snapshot, which
already omits its excluded paths. Once replay has virtually applied the accepted
revision, the second merge uses that accepted base with current exclusions only.
Reapplying old accepted exclusions there would turn identical remote additions
into false concurrent authored changes, causing an archive on a pure pull.
Runtime pending/lost-ack tests and generated ignore-toggle proof remain required;
the pure planner examples do not establish those recovery guarantees.

### Reject unsafe ancestors before local replacement

The follow-up receive regression demonstrated an actual workspace escape: a
remote `private/new.md`, an ignored local `private` symlink to an outside
directory, and no existing outside `new.md`. The leaf guard saw no existing
target; recursive mkdir and rename then created the file outside the workspace.
Ignored file and dangling-symlink parents instead produced platform errors.

The target guard now lstats the workspace root and each existing ancestor before
checking the leaf. A symlink or non-directory parent is refused with the same
typed failure naming the offending parent. Missing parents remain eligible for
ordinary new-directory creation; a missing root is a changed-workspace failure.
Ancestors are checked even when the leaf was present in the captured inventory.
The guard still runs before retain/upload and again before local mutations.

Three real-filesystem cases cover directory links, files and dangling links.
They assert that no outside file is created, existing outside/private data is
untouched, no archive or upload precedes refusal, and retry after restart remains
safe. Recovery cases also exercise creating normal missing parents. This does
not make a sequence of lstat/mkdir/rename calls atomic: a parent can still change
after its check. Native-path identity, root replacement and that race remain
part of the filesystem adapter's stronger guarded-replacement contract.

### Directory-only patterns and subprocess scaling

The plain-ignore fixture now explicitly includes `cache/secret.txt` under a
`cache/` rule, a root file `cache2`, and a nested file also named `cache`. The
directory is excluded before descent; both files remain included. Git correctly
recognizes the existing directory without SKIT appending a slash to every name.

A real 1,000-directory fixture contains one file in each directory. It verifies
all 1,000 files and all 1,000 directories are observed while allowing at most four
Git subprocess calls. The budget is checked before each spawn, so a regression
to one process per directory fails promptly. This proves bounded subprocess
growth for populated trees; it does not establish daemon wake/offline timing or
the cost of arbitrarily deep empty-directory hierarchies.

### Native write identity: implementation boundary

The sync pass keeps physical identity out of persisted history and bindings,
but captures it alongside the exact raw tree used for a sync pass. Canonical
transport keys alone cannot authorize writes on a normalization-sensitive
filesystem.

```text
Before (47bce1417)
core Author walk -> normalized entries -> CLI file map (native identity lost)
syncDraft -> joins canonical paths -> type-only ancestor/leaf guard -> mutation

After
core Author scan -> raw entries + native dev/ino observed before byte reads
local-tree owner -> checked transport files + guarded native target resolver
syncDraft -> resolver before mkdir and again before rename/remove
```

The local-tree owner retains native paths for observed files/directories,
verifies their recorded identities, and rejects unproven normalization aliases.
New paths must not introduce an NFC twin of an existing native entry. Non-NFC
native names can still be sent; receiving on a normalization-sensitive filesystem
is held with an explicit report. Alias equivalence must distinguish separate
hardlinks from two spellings of one directory entry. Root identity is captured
too. These checks narrow the unsafe window; lstat plus rename remains a sequence,
not an atomic filesystem compare-and-replace operation.

File identity is checked before and after capture reads. A changed inode during
capture becomes a retryable local-change failure. Before replacing an observed
file, the guard opens a scoped handle, verifies its identity before reading,
streams its current digest, and verifies the path identity again. This also
detects an in-place edit made during parent-directory preparation, which an inode
check alone misses. The guard is repeated after mkdir and before rename.

Tests preserve identical-byte atomic replacements of the file, parent and root;
reject replacement during capture; retain editor saves during apply and replay
the accepted revision on restart. Actual native Unicode sending/receiving passes
on this Mac. Three real NFC/NFD twin cases (distinct files, hardlinks, and a new
incoming name beside an ignored entry) explicitly skip on this filesystem and
remain required Linux VM proof. Physical identity changes leave content hashes
unchanged. These are bounded guards; concurrent writes after the final checks
remain part of the stronger filesystem adapter work.
