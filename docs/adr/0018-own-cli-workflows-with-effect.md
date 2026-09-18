# Own CLI workflows with Effect

> All Projection journal, recovery, transaction-phase, rollback, and terminal-sweep material in
> this historical decision was superseded by
> [ADR-0020](0020-treat-projections-as-reconcilable-derived-state.md). Names in those passages refer
> to the retired implementation, not the current API.

## Decision

Use Effect to own complete I/O workflows: their dependencies, expected failures,
interruption and resource lifetimes. Pure identity, planning, normalization and
rendering functions remain ordinary TypeScript when they do not need an execution
context. A migration is successful when ownership becomes clearer and behavior is
intentional, not when every function returns an Effect.

The CLI process has one application runner, `NodeRuntime.runMain`, in
`packages/cli/src/application.ts`. Native handlers return Effects to dispatch.
They do not run them, provide the platform layer independently, or render through
another runtime. The application provides platform, Renderer and RegistryHttp
services. Help, startup credential reads, native dispatch and result/failure rendering
participate in that lifetime.

SIGINT and SIGTERM interrupt the root fiber. Native operation scopes finalize before
the process exits. Pure interruption is not an authentication or operation failure,
produces no successful command result and exits 130 (the installed NodeRuntime policy
for either signal). Cleanup defects remain visible even when interruption initiated
cleanup. Failure rendering runs uninterruptibly after operation finalization; the
process exit code reflects a reported failure rather than hiding it behind a normal
interruption exit.

### Command outcome contracts

Each leaf in the typed `Command` tree owns its `CommandMetadata`: output schemas and the
semantic exit codes callers may branch on. The shared `result()` constructor derives payload
types from `outputContracts`, but its optional `exitCode` remains `number`. Per-command exit-code
truth is checked at the executable boundary in `declared-exit-codes.e2e.test.ts`, where the
binary's actual classification is compared with the generated manifest.

Do not restore the former `commandEffect`, `DeclaredErrors`, or `CommandResultOf` gate. That gate
depended on the deleted parallel command catalog, admitted unclassified native `Error` values for
every command, and checked a manually described error union rather than the failure classification
the binary actually publishes. Rebuilding it from annotations would add a second typed wrapper
around Effect's `Command.withHandler` without proving runtime classification. A narrower static
gate is only warranted if the command tree can carry the leaf metadata in its own type and the gate
can cover every reachable typed failure without admitting a catch-all `Error`.

## Why Effect belongs here

SKIT combines acquisition, subprocesses, archives, retained filesystem state, network
operations, verification and rollback. These operations benefit from structured
lifetimes and declared dependencies. Publication and source acquisition can already
make resource ownership substantially clearer. Projection transactions are the next
major proving ground because they add a durable commit point and recovery.

Effect does not replace the domain's transaction design. A Scope finalizer can clean
temporary files or roll back an uncommitted local change during cooperative
interruption. It cannot undo an accepted Registry write, recover after SIGKILL, or
substitute for the Projection journal and startup recovery. Finalizers must respect
the operation's actual commit point.

## Reference workflow

`skit inventory` is the reference application slice. It is small enough to read from
the handler to durable state, while still exercising the reasons this application uses
Effect: injected services, typed expected failures, interruptible filesystem work,
recovery, scoped temporary output and one atomic commit.

The named `inventoryCommand` workflow owns status presentation and preserves the exact
domain error channel from `refreshInventoryForCli`, which selects device roots and filters
the returned view. Core `refreshInventory` owns the state snapshot, recovery, observation
and publication. The handler only turns the successful value into the versioned command
result; the root failure renderer classifies failures for the CLI. `runCli` supplies services
and runs the root fiber. No layer construction or runtime entry occurs inside that path.
`doctorCommand` composes the same refresh with its own status presentation and applies the pure
`libraryDoctorReport` view; it does not reach the compatibility Library class or provide a
second store.

`skit check` is the companion read workflow for Source acquisition. `checkCommand` owns its
status, and `checkSources` loads the application `LibraryStore` once before resolving each selected
Entry in its own Scope. Resolver, validation, query and identity failures remain distinct through
the root command boundary. The former `SkitLibrary.checkEffect` and Promise `check` implementations
were removed; update preview calls the same native operation. Collection-identity derivation is a
shared pure module rather than a private Library method.

Publication remains the richer HTTP and resource-lifetime example. It combines credential
resolution, descriptor and remote checks, validation, archive production, temporary
storage, Registry discovery, upload and response decoding. Author listing is its simpler
companion for pagination, response decoding and read cancellation. Those workflows do not
replace inventory as the reference for the complete application shape.

## Inventory refresh and local state

`skit inventory` is a refresh, with filesystem mutations. Its native handler yields the
standalone `inventoryCommand`, which uses Renderer status under the root application
runtime and composes `refreshInventoryForCli`. That workflow composes core `refreshInventory` using the application
`LibraryStore(home)` Layer. Neither workflow constructs or calls a Library class.
The store acquires filesystem capabilities without reading or creating state; each
load reads a fresh current v2 snapshot (or empty v2 when missing). Refresh loads one state,
selects global roots followed by Binding roots in persisted order, deduplicates
Harness/root pairs, recovers interrupted Projection work once, observes every selected
root, and publishes the complete v2 snapshot once. Directory entries are sorted.
Managed Projections continue to be checked across the loaded state, as before.

Core `observeInventory(state, roots, options)` is independently read-only: it clones its
input and neither recovers nor writes. Lexically unselected unmanaged/custody evidence,
Library intent and journal records survive in the durable snapshot. The CLI filters
unselected unmanaged/custody evidence only in its returned presentation. Physical
aliases retain the existing native path-identity comparison semantics and combined
Harness evidence. Root enumeration skips only NotFound and PermissionDenied failures;
other scan/hash/marker I/O failures fail the refresh. Defects and interruption never
turn into a skipped root. As before, a skipped selected root clears its stale observed
unmanaged/custody evidence. OwnershipMarkerDisagrees alone becomes conflicted status.

State reads parse JSON as unknown and decode the complete current model with Effect Schema.
The local-storage ownership decision below supersedes the original shared Valibot decoder.
Known fields are validated and extension fields are preserved recursively. Malformed JSON,
invalid fields, and non-current versions produce `InvalidLibraryState` with path and validation
detail; inventory declares validation exit 65. Platform/tree failures remain exit 1.
A missing Library reads as empty v2 without writing; an explicit successful refresh can
publish its first snapshot. V1 support and its migration command were removed in `69f92cd`;
this schema consolidation does not restore them or introduce a new storage version.

`LibraryStore.publish` encodes state through the schema and owns a temporary directory beside state.json.
Its atomic-output helper is shared with the other JSON writers and is the publication primitive for future migrations. Scoped acquisition
creates that directory before interruptible JSON output, preventing a late native
write from recreating output after cleanup. The atomic rename replacing state.json
is the narrowly uninterruptible commit point; finalization removes temporary output
on success, failure or cooperative interruption. A committed file is not reverted
by an interrupt arriving afterward. Cleanup failure is a visible defect. The scan is
interruptible. This is atomic file replacement, not locking or a concurrent-writer
transaction; existing concurrent refresh/mutation writers can still lose updates.

Recovery accepts a native Effect persistence dependency with its own error/environment
parameters. Restoration narrowly masks destination removal and copying from the
backup. Unlike the previous rename, copying preserves the backup until the rolled-back
journal phase is durably published. Failure or interruption before that publication
leaves a replayable pending journal and recovery copy. Only a durable terminal phase
authorizes sweeping backups; a subsequent publication records residue clearance and
journal retention. Journals are not pruned while they still own recovery copies.
Recovery commits independently: later observation failure leaves completed recovery
durable and the last observation intact. No new journal phase is introduced.

The application exposes one current schema-v4 `LibraryState` through `LibraryStore.load`. It has no
legacy union, `loadStrict`, or migration callback. Native inventory tests inject scan/hash/output
failures, defects and deterministic interruptions; they assert exact publication counts, input
immutability, temporary cleanup, commit persistence and recovery replay from reloaded disk.
Store tests additionally exercise nested extensions, invalid candidates, absent Git provenance,
and read-only current-state loads. There is no historical version conversion to exercise today.

## Single-Projection transaction lifetime

Core `setProjectionEffect` acquires `LibraryStore`, loads and recovers once, validates
retained content with the loaded security acceptances, and composes
`withProjectionTransactionEffect`. Inputs supply normalized root/variant locations,
invocation intent and the timestamp seam. No Library class, production provider or
nested runtime participates in this standalone workflow. Binding orchestration now
uses the native batch boundary described below.

The transaction clones a private baseline and candidate. Its stage receives the
candidate through `transaction.state` and returns its result; the coordinator returns
that result and the committed state. Prepared and materialized journals publish with
baseline intent. Candidate intent and committed journals share one atomic replacement.
Declared paths must authorize every actual project/retire request before filesystem
mutation; duplicate requests are rejected. Multi-Harness transaction IDs and marker
formats remain unchanged.

`LibraryStore.publish(state, onCommitted?)` now notifies its owner synchronously within
the masked replacement, before publication scope cleanup. Wrappers must forward that
callback. This is necessary because interruption or a finalizer defect can arrive
after rename but before publication returns. The coordinator records commit there,
so those failures never republish baseline intent or run precommit rollback.

Native temporary trees and file handles are scoped. Recursive staging copies use
interruptible reads and writes through scoped handles, with individual namespace
changes masked; an abandoned recursive `cp` cannot recreate cleaned output. Hashing,
validation and verification remain interruptible. Displacement renames await settlement;
durable journals already own restoration before those renames begin. Custody is
rechecked immediately before displacement.

Failure, defect or interruption before commit restores requested paths in reverse
request order and attempts every restoration. It copies backups, retaining them until
baseline intent plus rolled-back journals is durable. Failed restoration or publication
leaves pending journals and recovery copies. Primary and secondary Causes are combined.
After commit, sweeping failures remain observable and retain committed journals for
replay. Successful sweeping publishes residue clearance before terminal retention
pruning can discard journals. A failed mutation therefore does **not** imply that no
mutation committed; callers must inspect/recover authoritative state.

`LocalSkitLibrary.setProjectionEffect` is a provider adapter; its promise counterpart
enters the existing runtime once. The optional promise verifier remains exclusively a
compatibility seam. Install/update/remove retain the explicitly legacy promise
coordinator and share materialization/retirement policy with the native path. Their
orchestration is not interruptible. Reconciliation remains a promise consumer.
Standalone and Binding mutation interruption are tested under the real platform Layer
with isolated filesystem fixtures and deterministic gates.

## Binding batches and explicit enable/disable

`binding-policy.ts` owns the extracted pure query, Binding, revision and enabled-Skill
selection rules. `binding-mutation.ts` acquires the application store once and recovers
through its unchanged publisher before planning. It stages every Skill of each changed
Entry, including disabled siblings, in one `withProjectionTransactionEffect` candidate.
Bindings, Projections and tombstones commit in the same replacement; Entries and
unrelated metadata survive. Repeated concrete requests are coalesced only when their
intent agrees. Physical route collisions and distinct Skills selecting one concrete
destination fail before preparation. One `update` journal per Harness authorizes mixed
project/retire batches; per-request roots use the shared Library root policy. No state,
marker or journal version changes are introduced.

Core `prepareProjectionEffect` validates retained inputs with loaded acceptances and a
batch timestamp, sharing identical validation results within the batch.
`stageProjectionEffect` is shared with standalone mutation and only edits the enclosing
candidate. The coordinator masks its cleanup decision and restores interruptibility
for the operation: interruption at a nested hashing boundary must not skip rollback.
Before commit, all attempted destinations and baseline intent are restored. After the
commit callback, failure or interruption leaves candidate intent and replayable cleanup;
no previous Binding reapplication is permitted.

Preview loads one coherent snapshot without recovery, publication or materialization.
It preserves the existing descriptive dry-run semantics, not a full validation audit.
Stored previews check the content-derived Entries/Bindings revision before any write,
then check it again after recovery before Projection preparation. Observation-only
changes do not alter that revision. Confirmation uses the preview's normalized Skill
selection; the guard does not guarantee exclusion of concurrent writers.

Explicit enable/disable, including collection `--all`, no-prompt Harness defaults,
repository/global Scope, invocation options and `--dry-run`, runs through the typed command
leaf, application services and Renderer status. Harness detection uses
native probes with the existing synchronous selection policy; repository resolution is
pure path resolution. Real executable SIGINT/SIGTERM tests gate filesystem reads and
state writes, await exit 130, and recover reloaded state twice.

Interactive selection remains `interactiveSetEnabledCompatibility`: prompts and
terminal cancellation are not native in this slice. Once submitted, the existing
`SkitLibrary.setEnabled`, preview/apply/execute promise adapters execute the native batch
once. This provides neither interactive terminal interruption nor atomicity across
separately confirmed Library-session operations. Reconciliation, add/pull, removal and portable-sync orchestration retain their legacy
boundaries. Author initialization now uses the native protocol below.

The enable/disable catalog now declares previously omitted exits 64 (argument/selection
failures) and 65 (invalid state or retained content). Output schemas and status text are
unchanged. Distinct Skills targeting one concrete folder now fail `TARGET_COLLISION`
before mutation rather than accumulating independent conflicting Projection commits.

## One observation of a mutable Source

A local Source is a directory the user can edit while it is being acquired, and add reads it more
than once: to validate the release, to hash the verbatim Original, and to copy each of those into
its content-addressed home. Retention verifies every object it writes against the hash that names
it, so a retained tree always describes its own bytes. That is not enough on its own — the
observations still have to describe one state of the directory.

Add validates once. The validation that decides the changed-content conflict is the validation
`installDirectory` commits from, rather than a second read taken after the decision; otherwise an
add could be admitted on one set of bytes and committed from another, which is how the
`SourceAlreadyRetained` policy was silently defeated.

It then re-observes the normalized view after retention, before the commit. This matters because a
release whose content address already exists is never re-read: retention verifies the _retained_
object, not that the Source still matches it, so without the re-observation an Entry could pair a
release hash from before an edit with an Original hash from after it. The Original is hashed inside
the interval the re-observation brackets, so a match proves both addresses describe one state.
`SourceChangedDuringAcquisition` rejects a mismatch while nothing has been published; retrying
against a settled directory is the remedy.

This rejects inconsistency rather than taking a snapshot. Two limits follow, both deliberate. A
change confined to files the normalized view excludes — `.DS_Store`, `.git`, workspace metadata —
can alter the verbatim Original without the re-observation seeing it. And a change arriving after
the re-observation is not observed at all, which is the irreducible race of reading a live
directory. Archive and Git content is not affected: it lives in the acquisition workspace, which
nothing outside the operation's Scope writes to.

## The acquisition failure channel

Source acquisition declares only failures it can actually make. The `SkitError` member it
carried alongside them was vestigial — nothing on the path constructed one — and removing it
is the correction, not a rename.

Two adapters on that path converted whatever they caught into an ordinary failure: the source
classifier ended `return new UnsafeSourceUrl()`, and the direct-document guard caught
everything as `DirectSkillDocumentInvalid`. A programming mistake inside either was therefore
reported as bad user input and given a semantic exit code. Each rejection those adapters can
actually make is now thrown deliberately — including the unparseable URL, which arrives from a
non-throwing parse rather than from the URL constructor's `TypeError` — so anything else
reaching them is a defect and stays one. The named failures and their exit codes are unchanged.

This is the same narrowing the HTTP boundary already applies: an expected transport or parser
rejection enters the declared channel, and a `ReferenceError` from our own code does not.

## One acquired store and one authoritative commit (add)

`add` acquires `LibraryStore` from its caller — the application under the CLI, a deliberately
named compatibility provider for the promise facade — and loads one authoritative snapshot
through it. That snapshot is recovered once and is the state the workflow plans against,
conflict-checks against and commits. Non-current storage versions are rejected without writing;
there is no diagnostic conversion in the current store.

The Installation and the Entry are one commit. The Entry is staged inside the Installation's
own Projection transaction, so `transaction.state` carries both into the atomic replacement
that is already the transaction's commit point. Where the Installation is already current
there is no transaction, and the staged Entry is that operation's single publication instead.
Original retention runs before the commit rather than after it, because the Entry has to name
the Original it refers to; an immutable Original retained by an add that then fails is the
documented unreferenced-object case.

This gives a commit protocol rather than a compensation: a failure, defect or interruption
before the commit publishes no part of the add, and the transaction rolls back what it staged.
After the commit — in the tail where the transaction sweeps and publishes its terminal
snapshot, or during acquisition cleanup and rendering — both halves are durable and neither is
rolled back. There is no window in which one is durable and the other is not, so `add` leaves
the compensated region entirely. `pin`, `pull` and `update` keep it: they still write their
Entry after their Installation commit.

Two rules are preserved deliberately rather than as consequences of the old shape. Adding over
an Installation that has Projections but no Entry is still refused: a successful replacement
retires the dropped Skills' Projections and destroys their records, and with no Entry no
Binding records the Skill selection, invocation override or Scope to reproject them from.
Repeated identical adds, changed-content conflicts, Entry ordering and Author Workspace
safeguards are unchanged.

One store and one snapshot are coherence, not exclusion. A writer that commits between this
add's load and its own commit is overwritten, exactly as before — this slice introduces no
lock, no state version and no claim check, and the last writer still wins. What changed is
that an add is now internally consistent: it no longer plans against one read of state and
commits against another.

`installDirectoryEffect` takes the snapshot, the acquired store and the staged intent as
options; every existing caller passing none keeps its previous behavior, loading and recovering
its own state and publishing through the compatibility store layer. Because the store captures
its `FileSystem` when its Layer is built, a fault injected at the workflow no longer reaches
authoritative state I/O — tests that gate a publication must inject into the layer that builds
the store.

## Compensated re-installation

`pin` and `pull` share one compensation region, `compensatedInstallationEffect`. They differ in what
they install, not in what a half-finished installation leaves behind: each writes one collection's
Installation, retains an Original, refreshes that collection's Projections where it has any, and
then writes the Entry. `update` is `pull` per Entry and inherits it; it is deliberately not atomic
across Entries, so an Entry that already pulled keeps its result while the one that failed is
restored.

`add` no longer participates. It commits the Installation and the Entry together, as described
above, so it has no half-finished installation to compensate for. The paragraphs below describe
the region as `pin`, `pull` and `update` still use it; where they say "first-time `add` has nothing
to reinstall", that creation shape now simply does not arise.

The region covers two shapes, told apart by the durable record rather than by the caller. A
collection that already had an Installation is restored to it. One that had none was created by this
operation, so compensation removes exactly that record instead — first-time `add` has nothing to
reinstall. The distinction cannot be a caller-supplied flag: a re-add of changed content over an
existing Entry, and an `add` over an Installation left without an Entry by an older partial
operation, are both the replacement shape, and only the state on disk says so.

Removal drops that one Installation record and nothing else. A collection installed with no Harness
and no Binding carries no Projection, so there is nothing to retire and no custody to weigh; going
through `removeInstallation` would additionally refuse on unrelated grounds. Retained trees are
content-addressed and may be referenced by another Entry, and an Original is immutable, so neither is
deleted — an unreferenced object may remain, as elsewhere in this migration.

One replacement is refused rather than compensated. An Installation that has Projections but no
Entry cannot be restored after add replaces it: installing retires the Projections of any Skill the
incoming content drops, and once retired their records are gone, while the absent Entry means no
Binding records the Skill selection, invocation override or Scope to reproject them from.
`ProjectedInstallationWithoutEntry` refuses while the state is still intact, which is the explicit
rejection of an unsupported orphan shape that issue 14 asks for rather than a silent partial
mutation. An orphaned Installation with no Projection is supported and restored normally.

The region starts before `installDirectory`, not after it. `withProjectionTransactionEffect` marks
itself committed inside the publication that durably replaces state and then still sweeps and
publishes a terminal snapshot; a failure or interruption there returns a failure from
`installDirectory` with the new Installation durable, and the transaction deliberately does not roll
back once committed. A region entered after `installDirectory` returns cannot see that window.

Whether to restore is decided by the durable record rather than by which line failed. The
collection's Installation record is captured before the install and compared afterwards. An
unchanged record needs no restoration, whether because the transaction rolled itself back or because
`installDirectory` found the Installation already current and replaced nothing (local-library.ts's
`if (current) return previous`); a changed record is restored, including a same-release re-install
that really did replace it. Reaching `installDirectory` is not itself evidence that anything was
committed.

Restoration reinstalls from the previous release's own content-addressed path and rewrites the
Entries and Bindings captured at the start, which is what `LibraryReconciler.apply` did for an
updated Entry. It installs with no Harnesses, the branch that preserves the prior Projection records
instead of materializing them again, and then re-applies the captured Bindings for that collection.
The re-apply is necessary rather than tidy: reinstalling restores retained content and Installation
records but not the projected files once a Binding refresh has already rewritten them, so a failure
at the Entry write would otherwise leave the Harness holding a release the Library no longer records.
Re-applying uses the Skill selection and invocation override those Bindings recorded. Restoration
reports rather than refuses on a removed child with native changes, because a Skill the abandoned
release added may have been edited on disk — deliberately more permissive than `pull`'s forward
install, which still refuses an unapplicable Projection.

The whole region runs inside `Effect.uninterruptibleMask` with the operation's Exit inspected from
outside the mask. The mask, not a `catchCause` handler, is what makes this hold for cancellation: an
interrupted fiber skips what a handler tries to do next, and the promise paths were previously
shielded by the CLI's legacy settlement boundary. A restoration that itself fails is combined into
the reported Cause rather than replacing the failure that caused it.

This is compensation, not atomicity. The Installation commit and the Entry write remain two commits,
and restoration is a second forward install rather than an undo: the restored record is equal to what
it restored except for `installedAt`, which is stamped when restoration runs. Neither command
acquires `LibraryStore` or works from one loaded snapshot, so restoration rewrites the Entries and
Bindings captured at the start and a concurrent writer between those points is not protected
against. Portable sync,
`LibraryReconciler`, `installPortableEntry` and `add` are unchanged.

## Normalized acquisition of a descriptorless Source

A Source with no Descriptor is normalized into a generated wrapper under the acquisition
workspace. That wrapper is a copy the workspace owns, so it uses the same owned-copy
primitive as retention rather than a recursive `fs.copy`: each namespace change settles and
each file goes through a scoped handle, so releasing the workspace establishes that copying
has stopped. Symlinks are copied verbatim; the normalized tree policy rejects them as SKIT
content, so this governs what is staged, not what is retained. An unsupported filesystem
entry fails as a tree failure rather than a platform copy error.

The generated Descriptor records each Skill's `source_updated_at`, which must be a property
of the Source rather than of the acquisition. Acquisition therefore supplies it explicitly:
observed from Git history or the file's own mtime where the Source has one, taken from the
response's `Last-Modified` where a server declares one, and omitted where neither exists —
the field is optional, and inventing a value makes the generated release hash different on
every acquisition. That drift was observable: `add --list` advertised a Content Digest that
`add` did not retain, and re-adding an unchanged direct document was refused as a
changed-content conflict.

Preview and add resolve one Source through this one acquisition, but build their results
separately, so their agreement on identity, revision, release hash and Skills is a
behavioral guarantee tested per Source family rather than a property of shared code.

## Exact release pinning

`pin` is `pull` with a declared version, not a Library synchronization. `planPinEffect` and
`pinEffect` share one `pinAcquisitionEffect`, so a single Scope owns the download that both the
plan and the retained bytes come from; the previous implementation resolved the release three
times. The handler runs through its typed command leaf and Renderer status under the root runtime.
The `planPin`/`pin` promise methods are gone rather than retained: a caller inventory found no
consumer outside this repository's own tests, so the tests moved onto the native Effects instead
of a wrapper being kept to avoid moving them.

Pin no longer routes a single-Entry change through the portable-sync reconciler. Rebuilding a whole
portable manifest to change one Entry's release gave pin three behaviours belonging to N-entry
synchronization: it reprojected every Binding in the Library, it rewrote every Binding through a
manifest shape with no invocation field and so dropped invocation overrides, and it refused to run
while any repository-scoped Binding existed anywhere. Reconciliation is now scoped to the pinned
Entry's own Bindings. The `skit.pin.v1` schema, `projection_reconciliation` values and status text
are unchanged; what populates them describes the pin. A release that drops a bound Skill is still
refused, and a dropped Skill's edited Projection is still reported rather than refused.

`SourcePolicyViolation` carries an optional `status` where a rejected HTTP download constructs it,
so pin's authentication, access and missing-release remediation classifies from the failure rather
than by matching its message text. Pin's declared exit codes now include 64 and 65, which three of
its own named failures and its content validation could already produce.

`pin` now owns its Library state the way `add` does: it acquires `LibraryStore` once, takes one
recovered snapshot, and plans its identity, refusal and conflict decisions against the state it
commits. Its release is validated once and that validation is what `installDirectory` commits, so
the identity check and the retained Installation describe the same bytes. The Entry is staged
inside the Installation's own transaction, so both reach disk in one atomic replacement, and
Original retention moves ahead of that commit because the Entry names the Original.

The Projection refresh stays a separate commit, and the conflict it used to report is now refused
before it. Pin preflights every Projection it would displace — a Skill the incoming release drops,
and any Skill on a Harness this device has — asking the same custody question `retire` asks, and
fails `ProjectionNotSafeToPin` while nothing has changed. `projectionCustodyEffect` is that
question, extracted from `retire` so both ask it identically rather than one reimplementing the
other.

This is a product decision, not a mechanism. Pin used to install the release and report a modified
Projection as a partial reconciliation, which left the Library recording a release the Harness did
not hold. Refusing is simpler to explain and to act on: fix or disable the affected Projections,
then pin. The alternative considered and rejected was folding the refresh into the Installation's
transaction, which would mean changing a primitive that Binding mutation and author initialization
also use, and changing what they refuse.

Preflight is not a guarantee that nothing fails afterwards. Files can change between the check and
the refresh, so `projection_conflicts` and `projection_reconciliation: partial` stay in the schema
and in the code as the narrow race outcome rather than an ordinary result, and pin keeps
`compensatedInstallationEffect`: a refresh failing after the commit can still leave the Harness
holding a release the Library no longer records, and restoration plus the captured Bindings
re-apply is what puts that back. No locking, race protection or revalidation machinery was added.

Replacing the Installation is a commit, and the Projection refresh follows it. The reconciler recorded the previous Entry before acquiring and
reinstalled its retained content on any failure, so that compensation is preserved rather than
dropped: pin runs through the shared compensated re-installation described above.

The region has to begin before the install, not after it. `withProjectionTransactionEffect` marks
itself committed inside the publication that durably replaces state and then still sweeps and
publishes a terminal snapshot; a failure or interruption in that tail returns a failure from
`installDirectory` with the new Installation already durable, and the transaction deliberately does
not roll back once committed. A compensation region entered only after `installDirectory` returns
cannot see that window.

Whether to compensate is therefore decided by durable evidence rather than by which line failed.
Pin captures the collection's Installation record before installing and compares it afterwards. An
unchanged record needs no restoration, whether because the transaction rolled itself back or
because `installDirectory` found the Installation already current and replaced nothing; a changed
record is restored, including a same-release re-install that genuinely replaced it. Reaching
`installDirectory` is not itself evidence that anything was committed. The mask, not a `catchCause` handler, is what makes this hold for cancellation: an
interrupted fiber skips what a handler tries to do next, and the promise path was previously
shielded by the CLI's legacy settlement boundary. A restoration that itself fails is combined into
the reported Cause rather than replacing the failure that caused it.

This is compensation, not atomicity. The Installation commit and the Entry write remain two
commits, restoration is a second forward operation rather than an undo, and a failure during
restoration leaves the reported Causes as the record of what happened. Pin does not yet acquire
`LibraryStore` or work from one loaded snapshot, so its restoration rewrites the Entries and
Bindings it captured at the start; a concurrent writer between those points is not protected
against, as elsewhere in this migration. Portable sync, `LibraryReconciler`, `installPortableEntry`,
`update` and `pull`'s own handler are unchanged.

## Dependencies and HTTP

Use Effect services and layers for replaceable I/O capabilities. Pass operation inputs
such as paths, selected credentials, versions and Registry origins explicitly.
Read environment/configuration at adapters and composition boundaries, rather than
inside the publication workflow. Do not create services for pure helpers or every
small function.

RegistryHttp is the shared CLI Registry transport adapter. It uses the installed
`FetchHttpClient`, `HttpClientRequest` and `HttpClient.withScope`; it does not implement
a second cancellation mechanism. Each workflow opens a session in its own Scope,
so every request and response read is tied to that workflow. The root provides the
transport, not an application-wide mutable AbortController.

Tests substitute fetch through the same Effect layer. The adapter deliberately does
not enable retries, status filtering or additional redirect policy. Workflows
interpret Registry statuses; remote writes are never retried implicitly.

The adapter distinguishes transport and body failures and leaves unexpected
underlying rejections as defects. JavaScript cannot identify whether every TypeError
from an injected fetch implementation was a programming mistake or a transport
failure; the boundary classifies ordinary native HTTP rejections consistently and
tests the distinction with unambiguous defects such as ReferenceError.

Using Effect's HTTP implementation deliberately permits incidental transport changes,
such as its body buffering and request metadata. Tests should protect request
authorization, routes, payloads, operation ordering and resource guarantees, not the
identity of the Web Response method used internally.

## Failure and schema policy

Model a domain failure separately when a caller can make a meaningful decision from
it or it carries useful domain context. Do not create a new error class simply for
every implementation branch. External failures retain useful causes and context;
programming defects and interruption do not enter ordinary recovery paths.

Use narrow adapters around external throwing APIs. Application validation should
return typed failure explicitly, rather than throw inside a broad Effect.try wrapper.
Catch a named failure at the point where fallback is intentional. Catching all
expected failures is appropriate only when every variant genuinely shares that policy.

Valibot remains the source of truth for existing CLI and portable Library wire contracts.
`parseContractEffect` exposes safe validation as a native Effect while the synchronous
`parseContract` API remains available. Issue #10 deliberately changes the local-storage decision:
Effect v4 Schema owns current local Library models and persisted state. This authorization is
limited to that storage slice; it does not authorize a repo-wide wire-schema migration.
Internal tagged errors currently use Data.TaggedError; use a schema-backed model when runtime
decoding of that model is needed.

### Local Library schema ownership (issue #10)

`packages/skit/src/library/store/state-schema.ts` is authoritative for Entry, Binding,
Installation, Projection, journal, tombstone, custody observation, and assessment acceptance
models. Their TypeScript types derive from the schemas; `contracts.ts` re-exports those types
without a second handwritten definition. Small values intentionally shared across local models
include Digest, Collection Identity, Source, Harness, Scope, and Invocation Policy. Decoded state is
readonly except for the fields the reconciler revises in place, each marked with
`Schema.mutableKey`; the schema is therefore the record of what a transaction candidate may
change. Tests standing in for an edit made outside skit take a deeply mutable view instead of
widening that contract.

The current format stays `schemaVersion: 2`. Required fields remain required; discriminator,
status, and digest constraints remain enforced. Optional fields describe actual current data,
including absent `sourceRevision` on Git Entries retained before PR #9. Existing candidate
constructors may explicitly assign `undefined` to optional properties; JSON omits those keys.
Reading such an Entry preserves retained content and never acquires a commit from today's head.
Portable export retains its existing `NoPortableGitRevision` conflict and explicit
`skit update <collection-ref>` remediation. Only explicit acquisition records new evidence.

Unknown extension keys are preserved recursively during both load and publication using
`onExcessProperty: "preserve"`. Preservation is not permission to override validation of known
fields, and a future top-level version is rejected even if its fields otherwise look current.
Unsupported versions and malformed files are left untouched. The decoder reports validation
failure, never an empty replacement ledger or advice to discard custody evidence.

Command output owns independent Valibot schemas in
`packages/cli/src/commands/library-output-schemas.ts`. Its projection status and diagnostic
severity remain deliberately broader than storage's values. Portable Library schemas remain
owned by the distribution contract, with explicit mappings in `library/portable-manifest.ts`.
Neither wire surface imports the persisted-state schema; their existing versions and generated
JSON Schemas are unchanged. Named JSON Schema definitions/references are a separate follow-up
and must preserve ADR-0013's self-contained public documentation requirement.

SKIT is still in pre-1.0 development. Retain v2-only support rather than restoring the
unreleased v1 migration. A
schema-library change alone requires no on-disk transformation: loads leave the original bytes
untouched, and explicit publication uses the existing validated atomic replacement. The first
real format migration must ship a supported-version policy and custody-safe migration workflow
together.
Application workflows will continue to receive one current model; historical decoders and
transformations will live only at the storage boundary.

The primitives this relies on are `Schema.decodeUnknownEffect`/`encodeUnknownEffect`, the
template-literal Digest type, `Schema.mutableKey` and `Schema.mutable` for the revised fields and
arrays, and the `onExcessProperty` decoder policy. All are present in the installed `4.0.0-rc.112`.
Line references into an Effect checkout are deliberately not recorded here: the pin moves, and a
stale coordinate is worse than none.

Domain failures become executable codes and remediation at the CLI boundary. A
command catalog constrains the command's published outcomes; it does not define the
domain model. Failure rendering retains multiple Cause reasons so a primary failure
does not hide a cleanup failure. Interruption alone is kept separate.

## Startup and legacy boundaries

Startup credential reads now compose natively with the application. A Result snapshot
retains expected configuration failure for legacy commands; defects bypass the
snapshot. Commands needing a specific origin use native origin-specific resolution.
This retains credential selection without a startup runtime round trip.

Remaining promise handlers are explicitly transitional. Dispatch invokes them inside
an uninterruptible boundary and waits for settlement after a signal. The hybrid
mutating add path uses the same policy. This avoids abandoning their internal I/O
while pretending it has been cancelled, but it can delay shutdown indefinitely if
legacy work never settles. It does not grant that work native cancellation or
transaction safety. A forced process termination still requires durable recovery.

Migrate these boundaries one owned workflow at a time. Do not introduce new promise
handlers, detached fibers or nested runtimes to escape service requirements.
Server bootstrap has its own existing subprocess/signal handling; that remains a
legacy adapter, not the reference for native commands.

Promise facades are retained at actual compatibility boundaries for now. Native tests
use service injection, and facade tests verify their separate contract. Existing
facade tests alone are not a reason to keep a facade forever. Before removing an
export, inspect package/consumer usage and decide whether it is supported; do not
preserve or remove it mechanically.

## Intentional behavior, not historical accident

Preserve versioned output, identity semantics, useful authentication remediation,
pagination bounds and custody/transaction guarantees. Use executable baselines to
identify behavior, then decide whether it has a reason to exist.

For example, a null Registry rejection body should produce a deliberate response
diagnostic, not an accidental JavaScript property-access TypeError. Publication's
assessment diagnostics are validated before use. Invalid diagnostics fail as a
contract error rather than through an incidental array/property exception. Generic
failures remain exit 1 unless a domain decision justifies another classification.

## Validation

The reference includes real executable SIGINT/SIGTERM tests during listing request/body,
publication discovery, upload and response consumption. They use disposable loopback
servers, observe actual body reading, assert exact request counts and verify the
publication temporary directory is removed before process exit. A separate runtime
fixture gates asynchronous finalization and verifies a cleanup defect is rendered.

Native tests still exercise archive input/output ownership, typed failures, defects,
interruption, pagination limits and combined cleanup failures. Disposable Registry
end-to-end tests protect actual publication and direct-install compatibility.

Lint-rule tests are tooling checks, not evidence that these architectural guarantees
hold. Runtime ownership and transaction guarantees need behavioral tests at their
real boundaries.

## Alternatives rejected

- Continuing command-by-command syntax conversion without defining the process
  lifetime: it leaves central cancellation guarantees unconnected to the executable.
- Wrapping legacy promise operations in interruptible Effects and declaring them
  migrated: cancelling the wait does not cancel the underlying mutation.
- Building a custom HTTP framework: the installed Effect client already provides
  transport injection, request construction and scoped cancellation.
- Converting every synchronous helper or replacing all schemas: neither is necessary
  to establish I/O ownership, and both obscure the operation being migrated.
- Preserving every observed exception or adding tags merely for stylistic uniformity:
  compatibility and failure distinctions need a product or architectural reason.

## References

The upstream documentation entry point is
[Effect LLMS.md](https://github.com/Effect-TS/effect/blob/main/LLMS.md), with examples
under `ai-docs/src` for functions, services, running, resources and HTTP.
The installed `4.0.0-rc.112` source and types are authoritative for APIs used here.

## Author initialization commit protocol (issue 13)

The Library replacement is the authoritative registration commit. Workspace files and
Library state do not share an atomic rename. Exclusive scaffold writes survive failure;
initialization never removes the workspace or rolls back user edits. The default scaffold records its slug in `.skit/init-scaffold` before output. Retry
resumes this durable intent, atomically creates missing files exclusively and preserves
existing files (including user edits). The Descriptor is published last; the checkpoint
is removed only after completion. This also handles ordinary write failures and SIGKILL,
without masking the entire scaffold. Existing Descriptors remain untouched.

A workspace identity is durably installed before retention, with registration unspecified
until commit. It survives failure and supplies the same ID on retry. Missing metadata is
repaired from retained authored identity. An explicit registration of a removed workspace
keeps the removed marker until the Library commits. Finalization then atomically changes
the marker to registered. If finalization fails, the committed Entry takes precedence on
retry, including over a stale removed marker. Identity conflicts are checked before these
writes. SIGKILL during initial identity publication may leave no identity; no Library
reference can yet exist. This protocol does not provide concurrent-writer exclusion.

Immutable retained objects may remain unreferenced after failure and are verified before
reuse. Only temporary copies are scope-owned. One Projection transaction publishes the
replacement Installation and Entry, existing Bindings, refreshed Projections, removed
Skill retirement and tombstones. Pending journals retain baseline intent. Failures after
the commit notification never restore baseline intent, including workspace finalization
failure. Missing Skill names and their invocation overrides remain in Bindings as dormant
intent, as in the compatibility implementation; reintroducing the name restores that
intent. Descriptor defaults do not add Bindings or alter surviving Binding selection.
