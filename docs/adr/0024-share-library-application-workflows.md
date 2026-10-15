# Share Library application workflows across front ends

## Decision

`packages/cli/src/library-application` owns Library session transitions, update orchestration,
shared read models, and the local application layer. CLI and TUI consume its supported
`index.ts` surface. Domain adapters remain in core and the existing workflow modules;
terminal rendering, prompts, and command output envelopes belong to CLI adapters.
All front ends import core through `@smolai/skit-core`, preserving one runtime identity
for service tags and schemas. The older `front-end.ts` facade retains presentation/audit
exports and re-exports the application surface for existing workspace consumers.

`binding-changes.ts` owns enable/disable and invocation changes. Front ends prepare requests
with `previewBindingChanges`, display the returned facts, and apply the opaque plan with
`applyBindingChanges`. The plan privately retains the Library home, revision, requests, and
projection routing; confirmation cannot reconstruct or redirect the operation. Plans are
in-memory handles for the current process, not persisted or wire contracts. CLI JSON schemas
remain separate in `set-enabled-contract.ts`, and terminal text belongs to presentation.

Interactive CLI selection uses `openBindingChangeSelection` before asking questions. Its preview
is tied to the Library shown at that point, so a change during prompting is refused at apply.
Selection and preview hold no writer and materialize nothing. Application execution owns the
writer, validates the original revision, publishes Binding intent, reconciles through the existing
Projection workflow, and advances each change only onto this action's previous publication.
The environment-free `binding-selection.ts` owns Collection-following and invocation policy;
filesystem observations and publication stay in the application workflow. TUI session state
retains the prepared plan and presentation facts, with no operation list or storage revision.

Library updates require an explicit `LibraryProgress` implementation. Stages and completions
carry subject identity, source change, and projection counts. The terminal adapter maps
these facts to the existing scoped spinner and completion lines. Other consumers can
observe structured events or explicitly supply the silent layer. A stage's completion or
failure follows its resource finalization; defects and interruption retain their Effect
semantics. Update result and CLI output contracts are unchanged.

## Transaction ownership

Command composition supplies dependencies and renders failures; it does not acquire the
Library writer. Mutating application workflows own writer scopes and attributed history.
Add, update, removal, authored workspace registration, security acceptance, and inventory
refresh acquire their transaction explicitly. Applying sync acquires the writer; its preview
does not. Binding/session confirmation retains its existing authoritative revision check.
Update and removal reload state after acquiring the writer.

Interactive browsing and questions run outside writer scopes. Setup acquires the writer
after confirmation, revalidates the approved plan under the lock, applies selected changes,
then releases it before the optional source-update question. Multi-destination Binding
changes share one transaction. Removal's authored workspace marker is finalized inside
the same transaction as removal, preventing re-registration from racing that marker.
Nested writer scopes remain reentrant, so one composed action produces one history event.
State-file migration retains its own writer lock even when initiated by a reader.

Registry credential/alias and repository-decision mutations use the same root storage
mutex through `withConfigurationWriter`, preserving exclusion with existing writers.
This adapter does not open Library state or record Library history. Login questions run
before the credential workflow acquires it. Read-only configuration commands do not lock.
Persisting setup's machine configuration likewise owns its write scope explicitly.
CLI handlers and the TUI resolve a required `SkitConfiguration` service at their application
boundary. Explicit state-directory flags take precedence over Effect `Config`'s
`SKIT_HOME`, with the account's `.skit` directory as the default. Account home,
SKIT state home, and XDG configuration/state roots remain separate values. Derived
CLI-owned file paths, storage services, and writer locks share this snapshot. The optional XDG
state override is preserved separately from the default state directory: when absent
or empty, skills.sh lock discovery uses `~/.agents/.skill-lock.json`. Empty XDG
configuration/state values are treated as unset. Account home is an OS boundary
input, not a ConfigProvider key; embedders can pass it to `resolveSkitConfiguration`. Standalone
applications construct it with `skitConfigurationLayer`; command handlers provide that layer
from their parsed flags. The configuration includes resolved directory settings and CLI-owned auth and registry paths.
Library layout belongs to core: projection and audit consumers take storage paths from their bound
`LibraryStore`; command options do not carry copies of the state, originals, or variants paths.
Domain layers consume a required `SkitConfiguration` service and do
not provide it again. Standalone adapters and tests also supply this boundary explicitly.
Configuration writers derive concrete root overrides from the supplied snapshot and
provide those paths to the protected program; they never re-read configuration.
`ConfigProvider` injection therefore controls both the lock and the actual file writes,
including commands without explicit home flags, without changing process globals.

Core's `MachineSettings` module owns `machine.json` reads, identity creation, discovery updates,
and repository decisions. Reads normalize supported document versions in memory without writing.
Mutations load the latest settings under the root writer and replacement mutex, preserving identity
and fields outside the requested change. V5 persists repository-decision initialization explicitly:
creating identity preserves discovery mode, while saving discovery choices or a repository decision
initializes it. V1–V4 reads remain read-only; older binaries reject V5 rather than silently treating
identity creation as completion of discovery. MachineSettings defaults new names to the hostname,
preserves saved names for unnamed operations, and honors an explicit setup name as a replacement.
They open no Library state and record no Library history.
Import no longer handles machine-document encoding, and repository commands do not depend on setup.
Setup retains the policy that an empty root selection narrows the scan without clearing saved roots.
Failures to read shared machine settings stop an update batch rather than being treated as failures
of an individual Source.

Core's `prepareRestoreEffect` owns completion of a manifest's retained content: it combines
available archives with reconstruction from exact source acquisitions, handles materialization
profiles, verifies digests and member bytes, and retains the verified content. It returns prepared
state without publishing it or rewriting acquisition provenance. Archive completion and source
translation are private; callers provide a destination and source access rather than a callback
implementing reconstruction. Sync still owns remote snapshot downloads, conflict decisions, and
the remote-write, projection-retirement, local-publication, reconciliation order.

## Command environments

`handlePlatformCommand` supplies platform capabilities for file/configuration operations.
`handleLibraryCommand` supplies local storage and audit services. `handleRegistryCommand`
supplies Registry transport/authentication. `handleSourceCommand` combines Library and
Registry environments for acquisition and synchronization. Local path configuration
does not resolve Registry credentials; sync resolves its selected Registry explicitly.
Each helper preserves the program's inferred requirements: unsatisfied dependencies
remain visible to the command tree and ultimately fail the executable's typecheck.

The full command environment remains available to contract generators and tests that
exercise multiple command families. It is not the default environment for each command.

## Validation

Boundary tests run a real parsed listing while another fiber holds the writer and exercise
Registry configuration with absent or malformed Library storage. A headless update test
uses injected transport and structured progress, verifies retained bytes and one attributed
history event, and supplies no Renderer. A Deferred-gated interruption test verifies progress
does not report a closed stage before asynchronous cleanup finishes. Existing focused
workflow, session, setup, sync, runtime lifetime, and rendered command checks cover the
preserved behavior.
