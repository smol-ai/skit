# Setup apply outcomes

This document is the test oracle for guided `skit setup`. It lists the durable effects guided apply makes in order, the state each interruption leaves, and the behaviour it must keep. `setupCommand` (`packages/cli/src/library/setup.ts`) previews, asks, and hands the approved plan to `applySetupPlan` (`packages/skit/src/library/setup/apply.ts`), which turns it into the Library's setup steps and calls `Library.setup` (`packages/skit/src/library/library.ts`), the owner of the apply sequence. It has two parts: **current behaviour**, traced from source and pinned by tests, and **desired behaviour**, the requirements every change must keep.

| Coverage | Where |
| --- | --- |
| Consent, staleness, ordering, partial failure, and scan counts of guided apply, with lossless disk snapshots | `packages/cli/test/setup-apply-outcomes.test.ts` |
| Lossless snapshot of declared roots (type, mode, link target, bytes) and its self-test | `packages/cli/test/helpers/disk-snapshot.ts`, `packages/cli/test/disk-snapshot.test.ts` |
| Removal previews, archive layout, linked sources, and stale removal plans | `packages/cli/test/setup-removal.test.ts` |
| skills.sh lock adoption and observed-source imports | `packages/cli/test/setup-lock-source-import.test.ts` |
| Local custody, alias retirement, and duplicate choices | `packages/cli/test/setup-manage.test.ts`, `packages/cli/test/setup-discovered-copies.test.ts` |

The acceptance tests drive `setupCommand` itself with `interactive: true`, a scripted prompter and renderer (`makeScriptedInteraction`), a real temporary filesystem and real Library services. `skit setup --json` cannot reach guided apply: it forces a dry run. Tests assert the typed `Exit`, validate a successful `SetupResult` against `outputContracts.setup`, and compare `captureDisk` snapshots of the Library home, the agent roots with their backups, and the skills.sh state directory. Scans are counted through the skills.sh lock-file read in the test FileSystem, both overall and after approval. Source changes are injected at explicit prompt, publication or filesystem gates. `packages/skit/test/library-setup.test.ts` independently gates a later step after an additive import and proves the native home lock stays held through the whole operation; an intervening Library commit during that operation is excluded.

## Durable state

| Store | Where | Written by | Atomicity |
| --- | --- | --- | --- |
| **Machine config** | `<home>/machine.json` | `MachineSettings.ensureIdentity` before the steps, when imports or managed copies need an identity; `MachineSettings.updateDiscovery` after them, under the setup's operation ID, which records the discovery folders before and after for undo | Atomic rename, under the home lock |
| **Library state** | `<home>/state.json` | `Library.setup`: the operation record with every step first, then each step's own saves, then each step marked Done | Atomic rename under the Library writer, held for the whole setup |
| **Migration backup** | `<home>/state.json.v<N>.backup-<time>` | Library layer construction over a legacy state | Atomic rename and file/directory flush before replacing and flushing the migrated state |
| **Originals** | `<home>/originals/<digest>` | Retention, before the state that references it | Content-addressed; unreferenced trees are inert |
| **Recovery folder** | `<home>/removed/<operationId>/step-<n>[-<m>]/` with immutable `receipt.json` | The Remove step, and Manage steps moving approved duplicates aside | Exclusive receipt publication before the first rename; progress is derived from actual paths |
| **Agent roots** | Harness skills roots and their `.skit-backups` | Removals (move out), binds (managed projection replaces the copy) | Per entry |

## Current behaviour

### Stages

Preview runs without the Library writer lock. On approval, `applySetupPlan` reads the Library, scans once against the approved plan ID, and builds the steps from that scan, recording what each step expects at every path it touches. `Library.setup` takes the writer for the whole setup, refuses the steps with `StalePlan` if the Library moved since the read, saves them as one Pending operation, then runs them in order and marks each Done. No step observes again: each checks the folders it touches against its recorded evidence immediately before touching them.

| Step | Effect | Source |
| --- | --- | --- |
| S0 | Preview: `runSetup` with `persistRoots: false`, plus a second observation if repository decisions were asked. The plan ID covers the candidates, the instances, the repository configs and the Library revision | handler `setupCommand`; core `library/setup/scan.ts` `scanForSetup` |
| S1 | Confirmation prompt; declining returns the preview | handler `setupCommand` |
| S2 | Read the Library, then the one apply-time scan, held to the approved plan ID; reviewed changes and version choices checked against it | `library/setup/apply.ts`; `library/setup/scan.ts` `revalidateSetupPlan` |
| S3 | If the plan imports or manages copies: `MachineSettings.ensureIdentity`, without scanning | core `library/setup/apply.ts` |
| S4 | Build the steps, failing `StalePlan` on any reviewed path that no longer holds its scanned bytes or identity: Import (one per Collection group, each lockfile's hash checked), Manage "existing", Manage "new", Update, Remove | core `library/setup/{local-import,manage,removal,apply}.ts` |
| S5 | `Library.setup`: save the Pending operation and root evidence before any writability probe or directory creation; check every reviewed entry, prepare the roots and save preparation completion; then run each step in order, removals last. A preparation or step that differs or fails stops the setup: `SetupStopped` with the operation ID; nothing that ran is undone | core `library/internal/setup/{run,prepare-roots,steps,moves}.ts` |
| S6 | If the plan saves roots, or created the machine identity: `MachineSettings.updateDiscovery` under the setup's operation ID | core `library/setup/apply.ts`; core `library/setup/discovery.ts` |
| S7 | Outside the writer: offer a skills.sh update check, which loads the Library and may prompt | handler `offerSkillsShUpdateCheck` |

A setup interrupted during S5 stays Pending in `state.json`; the next command's Library finishes it at startup when every remaining step is still as recorded, and otherwise marks it Stopped.

### Rows

| Condition | State left | Test |
| --- | --- | --- |
| Guided preview declined, or a dry run | Nothing written; one scan | `declining or previewing the plan applies nothing after one scan` |
| Library construction over a legacy `state.json`, including a preview | Loader maintenance only: `state.json` migrated and its pre-migration bytes kept beside it as a backup | `a foreign record setup would forget changes only the loader's backed-up migration until confirmed` |
| Non-interactive setup with `--work-dir` | A settings-only setup: an operation record with no steps, then `machine.json` saved under its ID | `non-interactive setup with a work dir records a guarded settings-only operation` |
| Any approved apply | One scan after approval, however many steps run | `an approved apply scans once after approval, whatever stages it runs` |
| Root preparation cannot write to a skills directory | `SetupStopped`; the operation, audit evidence and any machine identity remain durable. No selected skills retained, installed or removed. A retry requires a fresh review; retain-only does not prepare skills directories | `setup-apply-reviewed-plan.test.ts`: denied enabling / fresh retain-only review |
| A reviewed source or alias changes after recording but before root preparation | `SetupStopped` before retaining anything or installing/moving copies; the changed entry stays untouched | `duplicates.test.ts`: source/alias changed after recording |
| A replacement is edited after its installed row is saved but before the recorded apply finishes | `SetupStopped`; both copies and the new edits remain; no duplicate moved to recovery | `setup-duplicate-backup.test.ts`: installing boundary |
| A replacement is edited after the recorded apply is durably Done but before duplicate cleanup | Apply reports a preservation warning; both copies and the new edits remain; no duplicate moved to recovery | `setup-duplicate-backup.test.ts`: cleanup boundary |
| A selected file changes after approval, before S2 | `SetupPlanStale`; only the outside change is on disk | `a selected file changed after approval fails stale before any effect` |
| Another writer commits a Library revision after approval, before S5 | `SetupPlanStale` (before S2) or `StalePlan` (after); only the outside change is in the Library | `a Library change committed after approval fails stale before any effect` |
| A selected copy changes after S2, before its step is recorded | `StalePlan`; `machine.json` may be written; nothing reaches the Library | `bytes changed between the apply-time scan and a later stage fail stale` |
| The operation record cannot be saved | That failure; `machine.json` may be written; nothing reaches the Library | `a setup whose record is refused writes nothing to the Library` |
| A selected copy changes after the steps are recorded | `SetupStopped`; earlier selections stay managed; the changed copy is not retained; nothing removed | `a selected copy changed after the steps are recorded stops the setup` |
| A removal selection is edited in place after the steps are recorded | `SetupStopped`; earlier steps stay; the edited copy stays where it is, nothing removed | `a removal selection edited after the steps are recorded stays in place` |
| An additive step fails | `SetupStopped`; orphan originals may be written; no removal applied | `a failed additive step leaves every selected removal in place` |
| A later import group or selection fails | `SetupStopped`; earlier groups and selections stay; a bind can commit before its alias retirement | Not covered here |
| Remove: a later rename fails | `SetupStopped`; every additive step applied; a prefix of entries moved into recovery with their bytes; the rest untouched; inspection reports `saved` for the prefix and `at-original` for the rest. No rollback | `a failed removal move leaves a moved prefix, the rest in place, and a move record` |
| A removal selection gains a custody marker, even an invalid one, after the steps are recorded | `SetupStopped`; earlier steps stay; the copy stays where it is with its bytes, nothing removed. The tree hash excludes the marker; the recorded evidence includes it | `a removal selection that gains an ownership marker after the scan stays in place` |
| Remove: a later entry is replaced while an earlier one moves | `SetupStopped`; the earlier entry is in recovery (`saved`); the replaced entry is untouched (`conflict`) | `a removal entry replaced during an earlier move stays untouched` |
| Remove: receipt replacement is refused | Removal still succeeds: publication is exclusive and no receipt rewrite occurs after moves | `removal writes one immutable move record before moving files` |
| The process dies during S5 | The operation stays Pending; the next command's Library finishes it at startup | `setup-operation.test.ts`: `a setup interrupted after its record is saved is finished by the next Library` |
| S7 fails or is cancelled after a successful apply | The command fails, but nothing is undone: every step before it is durable | Not covered here |

## Desired behaviour

Guided apply lives in one workflow. Every requirement holds today:

| Requirement | Held by |
| --- | --- |
| Exactly one full discovery scan after approval, distinct from the preview scan, counted at the skills.sh lock-file read in the test FileSystem. Cheap identity and hash checks immediately before touching bytes are still required | `an approved apply scans once after approval, whatever stages it runs`; the S4 and S5 checks |
| The approved plan ID stays fixed; internal re-observation never refreshes consent | `a selected file changed after approval fails stale before any effect`, `bytes changed between the apply-time scan and a later stage fail stale` |
| A stale approval, or a change after the steps are recorded (a selected file, lockfile, symlink target or Library revision), means no further effects and a clear failure | `a selected copy changed after the steps are recorded stops the setup`, `a removal selection edited after the steps are recorded stays in place`, `a removal selection that gains an ownership marker after the scan stays in place`, `a removal entry replaced during an earlier move stays untouched`; lockfiles in `setup-lock-source-import.test.ts`, symlink targets in `duplicates.test.ts` |
| Additive steps run before removals; an additive failure means no removals | `a failed additive step leaves every selected removal in place` |
| If a removal fails, the durable partial state is documented and a recovery receipt is kept | The Remove rows and recovery filesystem tests. Immutable receipts describe the full inventory before any rename; inspection derives progress from both actual paths, including interrupted batches |
| A concurrent Library change is never silently rebased | `a Library change committed after approval fails stale before any effect`; during S5 the Library writer is held for the whole setup |

In every row, current and desired, bytes that cannot be reproduced are kept: a removed copy is moved, never deleted, and the tests compare its recovered bytes and mode with the original.

A setup's operation record, with every step's evidence, stays in `state.json` whether
it finished or stopped. A step's recovery directory exists only once that step has
written its receipt, which it does before its first move, so a recovery directory's
presence still does not mean files moved; inspection must derive file state from
immutable batch receipts and actual paths.
Non-interactive `setup --work-dir` uses a settings-only prepared apply and records
that effect; it no longer writes settings inside its discovery scan. Its explicit
flag still enables no skills. The settings-only result refreshes its observation
after applying, so advertised actions use the current plan identity.

`setup-undo.test.ts` now checks the prepared full-undo path: adopted marker
release, retained artifacts remaining available, preservation of new writable
copies (including reviewed user edits), restoration of explicit removals with
their original inode, stale-plan refusal, occupied and redirected destinations,
marker symlinks, receipt publication failure, interrupted Library/settings inverse
publication, repeated undo preserving later choices, and executable CLI actions
through the parser and rendered result. Changed-projection, partial-forward and baseline reconciliation cases are covered
by `installed-skill-changes.test.ts`; see `setup-recovery-refactor.md` for the complete
requirement mapping and remaining deliberate custody boundaries.

Automatic preservation now has final-state proof in
`setup-duplicate-backup.test.ts`: equal direct global directories move only
after every affected reader has a verified replacement, complete original bytes
remain recoverable, and full undo returns the original inode. Authored controls,
new repository ownership and changed replacements keep the old copy in place.
`setup-actions.test.ts` walks concrete actions for mixed directory/link cleanup
and full undo through the real grammar. Individual source aliases and eligible
equal global directories no longer require a duplicate-housekeeping question
after the user selects enablement; other duplicate intent stays explicit.

`setup-undo-sources.test.ts` verifies full undo of an observed-source import into
an already-followed Collection: prior membership, versions and any selected
override return while every acquisition and artifact remains. A verified local
re-observation of the prior retained snapshot uses the existing Acquisition model,
so ordinary source refresh can advance afterward. The tests also cover newer
source choices, corrupted originals, clock ordering, settings failure after the
Library inverse, sync merge compatibility, and real CLI preview/apply actions.


Baseline reconciliation now uses corroborated last-written projection evidence.
Equal current/desired bytes align metadata without replacing the directory;
untouched copies accept reviewed incoming updates; local-only edits remain active;
native deletions remain absent. Competing changes require a concrete retained or
current-copy choice shared by guided setup and literal CLI actions. Selected local
bytes become ordinary Library history, and exact original directories are saved
before either version is projected. Full undo restores the previous selection and
original directories while retaining that history. A settings-only work-dir call
performs none of this projection work. Source imports that change the reviewed
desired Version leave affected copies untouched and return a fresh-review
continuation. A later repository/authored/pnpm owner vetoes inverse replacement.
