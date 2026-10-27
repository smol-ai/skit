# Setup recovery

Base: `6eeb68cd8`. Work: `work_01m5wxyp31e009g72es1gc94ge`.

Before (rendering and projection internals omitted):

```text
setup review -> prepare removal moves -> private identity checks
setup apply [Library writer]
  -> S5 existing bindings -> prepare aliases -> bind -> move aliases
  -> S6 local custody -> prepare aliases -> retain/bind -> move aliases
  -> S7 removal moves
each move batch -> separate recovery directory
  -> write receipt -> rename -> rewrite moved flags (repeat)
user -> interpret receipt -> manually move files back
```

After (current working tree on `refactor/setup-recovery`):

```text
setup review -> prepare removal moves + operation directory (passive)
setup apply [Library writer]
  -> S5/S6 retain/bind -> alias batches in the same operation directory
  -> S7 removal batch in that operation directory
recovery-moves [owns inventory, identity and custody checks]
  -> publish immutable batch receipt exclusively before first rename
CLI library recovery list -> operation IDs + concrete inspect argv
CLI inspect / restore preview -> recovery-moves
  -> validate receipts and paths -> compare actual entries -> facts + plan ID
CLI adapter -> concrete inspect / preview / guarded-apply argv
restore preview -> captured facts + plan identity + apply
restore apply [Library writer] -> reobserve -> check reviewed identity
  -> restore verified saved entries into free original destinations
  -> reobserve -> restored / partial / conflicted facts
```

Callers retain responsibility for which copies are selected and when bindings are
installed. Recovery owns receipt interpretation, content checks and restoration;
callers never interpret mutable progress flags or perform recovery renames.
Restoring files does not change Library bindings or settings and is not setup undo.

Use `recovery` for filesystem restoration, reserving `undo` for a guarded inverse
of setup intent. Recovery is machine-local and retained indefinitely; no automatic
expiry or deletion is introduced. Immutable receipts allow process-interruption
inspection, including interruption between moves. They do not promise power-loss
durability. Existing Effect 4.0.3 exclusive atomic publication, FileSystem and
Library writer APIs supply the infrastructure; existing normalized/verbatim tree
hashes intentionally omit control entries, so recovery requires a private complete
filesystem fingerprint. Symlinks are fingerprinted and renamed without following
their targets. Rename across devices fails without a copy/delete fallback.

Checks immediately before rename and the Library writer exclude stale plans and
cooperating Skit writers. As with existing filesystem mutations, this is not an
OS sandbox against hostile concurrent directory replacement or arbitrary editing
of both receipt and files by an account with full write access.

Subsequent sections describe the concrete setup actions, guarded intent undo and
routine setup choice simplification added after this file-recovery boundary.

Validation of this milestone:

- CLI typecheck and distribution build.
- 67 focused filesystem/setup/command tests across seven files.
- 11 contract generation and compatibility tests; compatibility against
  `6eeb68cd8` passes without changing existing output contract shapes.
- Eight CLI exit-code checks pass (one HTTP fixture required local-listener
  permission after the sandbox refused it).
- Built CLI recovery help and JSON empty-list smoke checks.
- Focused lint and `git diff --check`.

This adds a recovery capability and its safety checks; it does not claim a net
source reduction. The removed coordination is mutable progress recording and
manual receipt interpretation. Recovery callers receive facts and one prepared
restore operation instead of implementing filesystem restoration themselves.

Full setup undo includes saved discovery roots and repository watch/ignore
choices, as confirmed by the user. It uses explicit prior/expected-after intent
and projection custody evidence, rather than treating file receipts or lossy
audit history as its sole authority. Retained artifacts remain available.

## Setup action ownership

Before (`6eeb68cd8`, still true after the recovery milestone):

```text
scanForSetup -> recommendation + shell applyCommand with a duplicate placeholder
CLI --apply -> openSetupReview -> prepareRecommended -> apply
CLI/TUI prompts -> selectedCopies -> duplicate policy -> prepare -> apply
JSON consumer -> hardcode selection/command order; cannot select a divergent copy
```

After (current working tree):

```text
scanForSetup -> observed facts + recommendation
openSetupReview -> typed source/copy/removal choices + allowed duplicate alternatives
  -> prepareRecommended / prepareExplicit -> captured selection + reviewId + summary + apply
CLI adapter -> preserve home, roots, work-dir and explicit selections in concrete argv
  discovery -> review actions per valid selection
  --compare planId -> passive current Markdown/digest comparison + explicit review actions
  --review planId -> passive summary + reviewed apply action
  --apply planId --reviewed reviewId -> reobserve selections -> compare both IDs -> apply
  result / stale / partial failure -> inspect recovery and review again actions
```

The application owns choice eligibility and the identity of reviewed intent. CLI
owns executable argv, including encoding a source choice as a stable digest rather
than putting internal NUL-separated keys into process arguments. The historical
shell `applyCommand` remains a deprecated compatibility field during the version
transition; consumers should follow the concrete actions. New explicit selections
must carry their review identity on apply. Existing recommendation-only `--apply`
remains supported, with its observation identity and explicit duplicate flag.
No prepared plan is persisted; review and apply both observe the explicit inputs.

The machine adapter now lives in `handlers/library/setup-machine.ts`; guided
prompts stay in `handlers/library/setup.ts`. `setupReview` owns the valid choices
and stable `reviewId`; `commands/setup-actions.ts` owns argv and wire schemas.
Setup uses `skit.setup.v9` and `skit.setup.applied.v2`, plus new review, comparison
and failure contracts. Operational failures retain observe/recovery continuations
in a result envelope with the original nonzero exit status. Parser failures keep
the shared error contract. Existing `applyCommand` is preserved as a deprecated
compatibility field; it is not emitted as an executable action.

Action milestone validation: 89 focused tests across 11 files pass, including a
client following actual parser actions through discovery/review/apply, passive
comparison, explicit removals and recovery, intersection of allowed duplicate
alternatives, and rejection of stale observations or changed reviewed selections.
CLI distribution build/typecheck, focused lint/format, generated contract checks
and compatibility against `6eeb68cd8` also pass. Existing setup and recovery
invariants remain covered. Full undo and automatic duplicate preservation are
covered in the subsequent sections and final requirement audit.

## Full undo: source findings behind the design

These source findings establish the undo boundaries implemented below:

- `setup-apply.ts` already wraps every Library publication to enforce the running
  revision. This is the application seam for typed prior/expected-after intent
  evidence published **before** each setup-owned publication.
- `saveSetupMachineConfig` calls `MachineSettings.updateDiscovery`, whose owner
  builds the new identity/settings under its read-modify-write lock. Capture both
  settings values under that owner before publication; observing only after a
  write cannot explain interruption before the observation. Undo scope includes
  discovery roots, per-repository decisions and their initialization state, plus
  display settings setup actually changes. Retained artifacts and their machine
  provenance must remain valid.
- Desired bindings are stored in account/global, repository/local and optional
  device-choice locations. An inverse must restore only changed entries/policies
  and preserve unrelated later choices. An initially enabled entry must stay
  enabled. Comparing/replacing the entire current Library is not acceptable.
- `currentSkillVersion` uses a retained local selection or the newest Source
  Acquisition containing the Skill. Capturing only `local_version_id` is
  insufficient when setup retention changes the effective selected Version.
  Keep newly retained Acquisitions/artifacts; restore the prior effective Version
  from retained evidence and guard against a later Version choice.
- Projection adoption may stamp a marker in place, retaining control/extra files.
  Replacing a linked destination keeps the link itself in `.skit-backups`; target
  bytes stay outside that mutation. Reproducible owned backups may be discarded,
  while irreplaceable ones are kept. Undo must account for all three cases and
  may not treat every new binding as a newly created directory.
- Full undo needs a passive plan identity covering current intent and filesystem
  evidence, checked again under the writer. Later edits must be preserved in
  recovery or reported as conflicts. Free-path file restoration alone supplies
  neither projection custody reversal nor the guarded intent inverse.

The final-state tests below cover pre-existing bindings/policies, selected Version
and machine-setting restoration, unrelated later Library/settings edits, newer
installed edits, interrupted/partial setup and repeated undo. Public undo actions
are exposed alongside that implemented capability.

## Guarded intent evidence: before/after design

Before (base `6eeb68cd8`; unchanged by the action milestone):

```text
setup apply [writer] -> MachineSettings.updateDiscovery -> write settings
                    -> LibraryStore.publish -> publication + best-effort audit
undo caller -> no authoritative prior/expected-after intent exists
```

After (intent-evidence boundary in the current working tree):

```text
setup apply [writer] -> operation header (original filesystem evidence)
  -> MachineSettings owner -> validated prior/next -> immutable setup settings receipt
     -> write settings
  -> publication wrapper -> typed prior/expected-after bindings + selected Versions
     -> immutable setup intent receipt -> LibraryStore.publish
setup-undo-intent -> operation before/expected-after + current fields -> passive per-key inverse
next: undo preview/apply -> compose this inverse with checked projection/file custody reversal
```

The records are specialized evidence inside the existing setup operation, not a
second Library baseline or a general projection journal. They contain bindings,
invocation choices, effective selected Versions, machine discovery decisions and
projection custody facts needed for that operation. Acquisitions, retained trees
and unrelated Library fields are not rolled back. A generated machine identity
and its default label remain valid provenance for retained local artifacts;
existing user labels and the discovery roots/decisions setup changes are guarded.
Inverse binding membership/policies and repository decisions are checked per key,
so unrelated later choices survive. Repeated undo recognizes prior values, while
a newer choice for a touched field remains a conflict.

The current `setup-operation.ts` captures the original entry identities, complete
content fingerprints (including a comparison without the ownership marker), link
text, existing ancestor identity, and prior projection records. It writes typed
settings and Library intent receipts before the corresponding publications.
Separate immutable publication acknowledgements distinguish confirmed changes
from an interrupted final step; they never override live custody or field checks.
Completion records only setup-owned expected values, rather than claiming later
outside changes as part of setup. Readers validate schema, receipt ordering,
acknowledgement digests, and continuity with the operation header.

The plain non-interactive `setup --work-dir` settings-only path now uses this same
writer/revalidation/receipt path. Its flag still changes settings without enabling
skills; dry-run, JSON discovery, comparisons and reviews remain passive. It now
performs the same approval-time revalidation as other applies. File-recovery
inspection recognizes setup metadata and still derives file progress from actual
paths. Apply results expose the operation identity even without file moves.

Intent-evidence validation covers capture before publication, per-key inverse
computation and interrupted publication. Projection/file reversal, prepared undo
apply and CLI actions are verified by the full-undo and reconciliation tests
listed in the final requirement audit.

The setup observation identity now includes the existing machine-settings
snapshot, so changing saved discovery settings after review invalidates that
approval even when `--work-dir` makes the discovered roots look identical.
Settings publication also checks the operation's expected settings/identity under
its owner before retaining inverse evidence. The settings-only non-interactive
path refreshes observations after its apply, giving subsequent actions a current
plan ID (initial observation, writer revalidation, then result refresh). No fresh
observation inherits mutation consent.

Additional proof: a reviewed work-dir action refuses newer saved roots while
preserving the machine identity and leaving skills disabled; a typed publication
interrupted after receipt publication leaves an inspectable uncertain step and
performs no described settings change. A later unsupported binding field also
survives inverse computation when undo removes the only setup-added entry.

## Full undo composition (implemented against base 6eeb68cd8)

```text
Before
intent inverse -> computed fields only
file recovery -> free destinations only
installEnabledSkills -> reconciles every Skill at the target
native projection backups -> private pending/kept paths

After
prepare setup undo -> validated operation + current intent/settings/files -> undoPlanId
  -> per-key guarded intent inverse
  -> unchanged / release custody / preserve successor / restore original / rebuild prior copy
apply [Library writer] -> reobserve same undoPlanId
  -> immutable inverse publication evidence
  -> rebuild missing predecessors in staging using the existing projection byte renderer
  -> verify full original fingerprints before displacing successors
  -> preserve only verified registered successors in a separate recovery operation
  -> restore originals into free destinations or remove only setup's verified custody marker
  -> publish guarded prior intent and prior projection custody
  -> restore guarded machine settings -> verify actual result
CLI -> concrete preview/apply/inspect actions; conflicts never imply overwrite permission
```

`prepareSetupUndo` owns operation decoding, per-key inverse computation, exact
review identity, the Library writer, inverse receipts, publication and completion.
Its file owner distinguishes unchanged paths, marker release, preservation of
registered successors, exact rename of saved originals and verified reconstruction.
`prepareProjectionRebuildEffect` reuses the existing projection byte renderer for
shared mappings and invocation policy; it writes only into caller-owned staging.
The general binding projector's selection and pruning behavior is unchanged.

Recovery distinguishes unmanaged displacement from explicit preservation of a
registered projection, checking registration and marker lineage as well as live
file evidence. Undo fails closed on conflicting touched intent or uncertain
custody. Adopted originals edited since setup are concrete conflicts; reviewed
edits to setup-created successors are preserved in a separate recovery operation.
Saved originals return by rename, retaining their inode and receipt-derived state.
Cross-device originals refuse instead of using copy/delete. Retained originals
are only read; reconstructed copies must match the complete before fingerprint.

Interrupted undo remains inspectable and requires a newly reviewed plan; there
is no persisted executable plan or automatic resumption. Typed inverse receipts
precede file and intent effects. Completion is immutable and prevents a repeated
undo from reversing later choices even if they happen to equal setup's after
values. An interrupted settings restoration can finish after the Library inverse
has already published. Machine-local inverse evidence and preserved successors
stay under recovery storage and do not enter the synced Library manifest. There
is no automatic expiry: removing those files manually can make undo unavailable.

The CLI exposes `library undo OPERATION` with passive preview and guarded
`--apply PLAN_ID`, executable continuations, failure actions and a rendered result.
Applied setup output advertises the undo preview. File recovery keeps its narrower
name and its explicit statement that it does not reverse bindings or settings.

An observed-source import can change membership of an already-followed whole
Collection independently of per-Skill Version selection. New receipts capture
the source Acquisition and retained-copy selection as well as membership. Undo
restores a verified retained predecessor through a source re-observation (below).
Legacy/missing source evidence and newer differing source choices remain concrete
conflicts. The changed-projection/partial-forward-operation matrix and
baseline-aware competing-change reconciliation are covered by the later
reconciliation boundary and its tests.

## Automatic duplicate preservation and decision ownership (current implementation)

```text
Before
guided setup -> selectedCopies -> UI duplicate question -> capture alias identities
JSON/recommended setup -> selectedCopies -> separate duplicate validation -> capture identities
review.prepare -> trust supplied duplicate evidence -> apply -> validate again

After
guided setup -> application facts -> ask only unresolved duplicate intent
JSON/recommended setup -> same application facts and explicit selection
review -> refine filesystem eligibility -> valid choices
review.prepare -> resolve intent once -> capture exact link or equal-directory evidence
  -> prepared summary lists preservation paths -> reviewed apply
local adoption -> prepare recovery -> retain/bind -> verify replacements for affected readers
  -> recheck protection and custody -> existing guarded recovery moves
```

The application review owns duplicate eligibility, user-choice validation and
capture of approval evidence. Rendering returns only intent. Individual symlinks
to the selected source need no housekeeping question after enablement is chosen;
their original text remains recoverable. Existing compatibility overrides remain
available. Enablement is still explicit; recovery never selects an unchosen skill.

The second eligibility case is equal unmanaged directories in known global reader
roots, outside SKIT's native destinations. Before, review forces a housekeeping
choice and `bindCopy` only prepares symlink retirement. After, shared observation
facts identify equal direct directories, review captures exact copy identities,
and local adoption prepares their recovery moves before binding. Only after a
verified replacement is readable by each affected harness may the existing
retirement owner apply those moves. Parent/root symlink aliases, marker ownership,
repository/authored/pnpm evidence and differing bytes remain explicit conflicts.
No broader overwrite permission is inferred from normalized equality: whole
directories, including excluded/control entries, are preserved by existing
immutable recovery receipts and complete fingerprints.

Filesystem refinement refuses automatic preservation of control entries and
rechecks repository/authored ancestry, pnpm protection, root identity, content and
ownership before moving. If a replacement was edited after Library publication,
the old copy stays active and the result reports a preservation warning. A new
repository marker before cleanup invalidates the operation rather than moving
the checkout. `preservationWarnings` is the current JSON field; legacy alias-only
fields remain compatibility views.

`setup-duplicate-backup.test.ts` checks complete saved bytes, excluded Finder
metadata, empty directories, original inode restoration by full undo, stale
choices, authored controls, later repository ownership and later replacement
edits. The generic client in `setup-actions.test.ts` follows discovery -> review
-> apply -> undo preview -> undo apply with mixed directory and link copies and
checks restored files and link text. The latest focused CLI validation passed 81
tests across ten setup/recovery/contract files, plus the CLI build/typecheck,
focused lint/format, and generated-contract compatibility against `6eeb68cd8`.

## Restoring followed source membership (current implementation)

```text
Before
setup intent evidence -> per-Skill versions + current Collection members
undo -> pin old Skill versions -> cannot reverse a followed Collection's members
  -> explicit conflict even with an intact retained predecessor

After
setup intent evidence -> selected existing source Acquisition + retained-copy identity
undo preview -> compare prior / setup-after / current source content selection
  -> verify prior retained source tree -> prepare a new local observation of that same snapshot
undo apply [writer] -> reverify evidence -> inverse receipt -> filesystem inverse
  -> publish prior binding/version intent plus the verified source re-observation
ordinary source refresh -> unchanged existing acquisition/selection rules
```

The re-observation uses the existing Acquisition model and retained-copy ID. Its
input names the actual local retained path that was read, not an upstream fetch;
it makes no fresh upstream observation claim and preserves the original exact
revision only because the retained snapshot is verified. Every earlier/later
Acquisition and every Skill Version remains retained. A newer differing active
source is a conflict. Repeated/partial undo recognizes the restored snapshot;
it does not repeatedly append observations. Clock ordering must be real and newer
than the current source observation; a future or malformed source timestamp is a
concrete conflict rather than fabricated observation time. No portable entity or
protocol schema change, source-selection side store, or generation journal is
needed. The application undo owner coordinates this with its existing guarded
publication; the generic source retention and sync owners retain their behavior.

Freshness checks use the actual current Skill/version intent. Only the candidate
inverse's version resolution uses the verified restored source, so a pre-existing
selected-version override can be restored together with membership without being
mistaken for an intervening user edit. The undo preview lists each Collection and
the from/to source snapshot digests. Source-copy content selection, rather than
the re-observation's newly allocated identity, determines repeated-undo behavior.

`setup-undo-sources.test.ts` drives actual skills.sh setup imports into a
pre-existing followed Collection. It proves the prior membership and effective
versions return, the binding continues to follow the Collection, no retained
copy/Acquisition/Version disappears, and a later ordinary source update advances
normally. It also covers a prior version override, stale newer source selection,
corrupted retained bytes, clock ordering, interruption after Library publication
but before settings restoration, one-sided sync manifest merge, and parsed/rendered
CLI preview/apply actions. Machine-local operation receipts stay local; the source
re-observation is ordinary portable Library history. Sync continues to use its
existing acquisition merge and conflict rules, with no new protocol or server path.

## Baseline reconciliation

```text
Before
setup observation -> classify onboarding -> skip every SKIT-owned copy
core projector -> render desired bytes -> compare marker/current -> preserve conflict variant
setup review -> no facts or active-version choices for existing managed drift

After (current working tree)
setup observation -> registered global projection + exact marker + current full file evidence
  -> existing retained-version renderer in scoped temporary staging -> desired hash
  -> classify baseline/current/desired as aligned / incoming / local-only / competing
  -> preserve native deletion and report uncertain ownership as protected
shared review -> routine facts + concrete version alternatives only for competing changes
approved apply [existing writer] -> revalidate captured facts
  -> retain chosen local version or preserve displaced copies -> bounded projection reconciliation
```

The baseline remains the Library's last-written projection digest, corroborated
by exact marker lineage. Desired bytes use `prepareProjectionRebuildEffect`, so
invocation policy and authored shared mappings have the same owner as writes.
Observation's only writes are scoped temporary renderer output; it changes no
Library/settings/installed/recovery paths and removes that output on exit.
Raw marker, inode and physical-parent evidence participates in plan identity;
normalized content equality alone does not establish mutation authority. A
managed path outside the selected global route, a repository/authored/pnpm owner,
a leaf symlink, or incomplete custody evidence must not become an automatic
overwrite. No parallel baseline store is introduced.

The native binding path also needs a setup-specific scope change: before,
`setup bindCopy -> binding-changes -> reconcileLibraryProjections` projects the
entire affected Binding, including unrelated Skills. After, setup requests
preservation of unselected projections; the binding owner derives the selected
Skill IDs and passes that boundary through reconciliation and native selection,
pruning, relocation and inactive-global retirement. Bounded global retirement
leaves repository-owned installations with their repository owner. Other callers
keep their existing default scope. This closes a real failure case in which
enabling an unrelated new Skill could rewrite an edited copy whose marker had
disputed the Library baseline. The application review must still reject disputed
custody for a Skill the user actually selected; bounded scope is not authority to
overwrite it.

Undo also needs declared projection coordinates, distinct from its broad file
inventory. A reproduced failure showed that a native-deleted copy left untouched
by setup could later be restored by its user, and undo mistook that later marker
for setup's custody claim and archived the restored active copy. The operation
header records only the approved projection paths. Undo correlates those
paths with completed setup or confirmed native projection publications before
reversing a same-lineage adoption/creation. Inventory presence and a later marker
alone are not inverse authority; ambiguous legacy/interrupted claims conflict.

Competing-version choice boundary:

```text
Before
shared review -> competing facts -> refuse apply (no version-selection path)

After (current working tree)
shared review -> validate retained/local-copy choice for one existing Skill
  -> include all of that Skill's reviewed global coordinates and choice in consent
approved apply [setup writer and inverse recorder]
  -> revalidate every coordinate -> retain explicitly chosen local bytes if selected
  -> recovery owner preserves displaced owned copies under the setup operation
  -> native owner projects only those reviewed, live coordinates
CLI/TUI -> select shared alternatives; rendering never grants custody
```

Protected coordinates remain unresolved. A choice must not restore a native deletion,
enable another Skill, or rewrite an unrelated projection. Retained incoming history and
all displaced local copies remain discoverable, and the existing typed setup inverse
owns reverting the selected local Version and restoring original directories.

Observed-source import continuation: the earlier sequence
`review current retained Version -> retain selected source -> reconcile old facts`
can predictably fail stale after the approved retention changes that Version.
The apply owner compares the current effective Versions with the
captured facts after retention. Coordinates whose desired Version changed are
reported as pending with a fresh observation/review continuation; they are never
reprojected under old consent. Other reviewed coordinates continue normally. The
review explicitly discloses this boundary. This is re-observation of new desired
bytes, not a stored plan or automatic renewal of approval.

Final custody audit identified that full undo needs the same external-ownership
veto as forward reconciliation. Before, duplicate capture/reconciliation owned a
private repository/authored/pnpm check while inverse file replacement checked
only Library marker lineage. After, a setup custody owner in `library-application`
provides that check to both forward and inverse file decisions. Undo rechecks it
before displacement/restoration, so creating a repository or authored declaration
after setup cannot turn retained marker lineage into permission to move its files.


## Requirement audit of the final working tree

| Contract | Evidence |
| --- | --- |
| Immutable inventory before moves, shared operation with unique batches, exact filesystem/link evidence, legacy normalization, occupied/stale/EXDEV refusal, interrupted and repeated restore | `recovery-moves.test.ts`, `recovery-command.test.ts` |
| Concrete selected-home/root/work-dir actions across observation, explicit choices, comparisons, read-only review, apply, stale failure and recovery | `setup-actions.test.ts`, `setup-reconciliation.test.ts`, `recovery-command.test.ts`; generated `skit.setup.v9`, applied v2 and new recovery/review/undo v1 contracts |
| Typed intent evidence before publication; partial forward/settings/Library effects; receipt acknowledgement uncertainty | `setup-operation.test.ts`, `setup-apply-outcomes.test.ts` |
| Guarded per-entry inverse of bindings, device/version choices, policies, saved roots and repository decisions; unrelated edits/artifacts retained; undo twice | `setup-undo-intent.test.ts`, `setup-undo.test.ts`, `setup-undo-sources.test.ts` |
| Changed independent projections, exact saved-directory restoration, adopted originals, newer edits, protected owners and redirected paths, interrupted inverse | `setup-undo.test.ts`, `setup-reconciliation.test.ts` |
| Baseline/current/desired classification, passive scoped rendering, local-only drift/native deletion preserved, marker disagreement protected, routine updates and marker-only alignment | `setup-reconciliation.test.ts` |
| Competing edits require a concrete retained/local active-version choice; both versions discoverable, exact originals saved before projection; partial choice undo | `setup-reconciliation.test.ts` through domain apply, literal CLI actions and guided renderer |
| Automatic equal global duplicate/link preservation after explicit enablement; replacements verified per reader before cleanup | `setup-duplicate-backup.test.ts`, `setup-actions.test.ts`, `setup-manage.test.ts` |
| Native binding/projection default behavior retained; setup limits selection/pruning/relocation/retirement to chosen Skills | `binding-changes.test.ts`, core `library-projection.test.ts`, `library-binding-entries.test.ts`, `projection-policy.test.ts` |

No new placement is inferred from a missing registered installation: native deletion
stays absent. Setup reconciliation operates on corroborated active global routes;
foreign routes, uncertain aliases and unsupported custody remain explicit conflicts.
Enabling other retained Skills/placements continues to use the existing binding
commands rather than granting mutation authority from mere backup availability.
Source imports that change desired Versions return pending outcomes and a fresh
observation/review action. That continuation deliberately requires consent to the
new desired bytes, rather than automatically rebasing the earlier approval.

These checks establish local source/CLI behavior. No commit, push, PR change,
deployment or full-workspace test run is part of this task.
