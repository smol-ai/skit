# Setup apply outcomes

This document is the test oracle for guided `skit setup`. It lists the durable effects `setupCommand` (`packages/cli/src/handlers/library/setup.ts`) makes in order, the state each interruption leaves, and the behaviour the setup-apply refactor must reach. It has two separate parts: **current behaviour**, traced from source and characterized by tests, and **desired behaviour**, the refactor's target. A desired row the current code violates has a test labelled `BUG`; that test pins today's behaviour so the refactor flips it deliberately, and is not a safety guarantee.

| Coverage | Where |
| --- | --- |
| Consent, staleness, ordering, partial failure, and global lock reads (a scan-count characterization) of guided apply, with lossless disk snapshots | `packages/cli/test/setup-apply-outcomes.test.ts` |
| Lossless snapshot of declared roots (type, mode, link target, bytes) and its self-test | `packages/cli/test/helpers/disk-snapshot.ts`, `packages/cli/test/disk-snapshot.test.ts` |
| Removal previews, archive layout, linked sources, and stale removal plans | `packages/cli/test/setup-removal.test.ts` |
| skills.sh lock adoption and observed-source imports | `packages/cli/test/setup-lock-source-adoption.test.ts` |
| Local custody, alias retirement, and duplicate choices | `packages/cli/test/setup-local-custody.test.ts`, `packages/cli/test/setup-discovered-copies.test.ts` |

The acceptance tests drive `setupCommand` itself with `interactive: true`, a scripted prompter and renderer (`makeScriptedInteraction`), a real temporary filesystem and real Library services. `skit setup --json` cannot reach guided apply: it forces a dry run. Tests assert the typed `Exit`, validate a successful `SetupResult` against `outputContracts.setup`, and compare `captureDisk` snapshots of the Library home, the agent roots with their backups, and the skills.sh state directory. Scan counts are characterized by reads of the global skills.sh lock: every `collectSetupEvidence` reads it once and no safety check does, so today the read count tracks full discovery scans. This is a lock-read characterization, not an acceptance-level scan observer: caching the lock would lower the count while repository traversal still repeats. `collectSetupEvidence` is a plain function with no injectable seam, so the setup-apply refactor must introduce a stable scan seam and an observer counter on it, and its one-scan requirement is asserted through that counter. Changes "after approval" and "after the first additive stage" are made at explicit gates (the approving prompt, the first Library publication, a named rename), never after a delay.

## Durable state

| Store | Where | Written by | Atomicity |
| --- | --- | --- | --- |
| **Machine config** | `<home>/machine.json` | `writeSetupMachineConfig`, whenever `runSetup` runs with `persistRoots` | Atomic rename, under the configuration writer |
| **Library state** | `<home>/state.json` | Each import, add, and bind publication | Atomic rename, compare-and-swap against the loaded base, under the Library writer |
| **Migration backup** | `<home>/state.json.v<N>.backup-<time>` | The state loader, on first read of a legacy state | Atomic rename; the migrated state is written after it |
| **Originals** | `<home>/originals/<digest>` | Retention, before the state that references it | Content-addressed; unreferenced trees are inert |
| **Recovery folder** | `<home>/removed/<uuid>/` with `receipt.json` | `applySetupRemovals` | Per-entry rename; the receipt is rewritten atomically after each |
| **Agent roots** | Harness skills roots and their `.skit-backups` | Removals (move out), binds (managed projection replaces the copy) | Per entry |

## Current behaviour

### Stages

Preview runs without the Library writer lock. On approval, everything up to the final verification runs inside one `withLibraryWriter` (`setup.ts` 274).

| Step | Effect | Source |
| --- | --- | --- |
| S0 | Preview: `runSetup` with `persistRoots: false`, plus a second observation if repository decisions were asked | `setup.ts` 96-97, 141 |
| S1 | Confirmation prompt; declining returns the preview | `setup.ts` 268-272 |
| S2 | Revalidate against the approved plan ID (a full scan) | `setup.ts` 276-279 |
| S3 | Explicit removals: preflight every entry, create the recovery folder, write the receipt, then rename each entry and rewrite the receipt after each move | `setup.ts` 280-289; `setup-removal.ts` 101-132 |
| S4 | If imports or adds are selected and the machine has no identity: `runSetup` with `persistRoots: true`, which writes `machine.json` | `setup.ts` 290-298; `setup-discovery.ts` 614-625 |
| S5 | Observed-source imports, one Collection group at a time, each retained and published before the next | `setup.ts` 299-312; `setup-observed-collections.ts` 144-234 |
| S6 | Existing-entry binds: observe again, revalidate against **that** plan, then per selection bind and project, then retire aliases | `setup.ts` 313-326; `setup-existing-binding.ts` 47, 83-90; `setup-local-custody.ts` 230-266 |
| S7 | Local custody: observe again, revalidate against **that** plan, then per selection `addLibrarySourceEffect`, bind and project, then retire aliases | `setup.ts` 327-341; `setup-local-custody.ts` 82, 128, 157-177 |
| S8 | Verification: `runSetup` with the approved `persistRoots`, which can write `machine.json` (skipped when only imports ran) | `setup.ts` 342-361 |
| S9 | Outside the writer: offer a skills.sh update check, which loads the Library and may prompt | `setup.ts` 362, 366-395 |

### Rows

| Condition | State left | Test |
| --- | --- | --- |
| Guided preview declined, or a dry run | Nothing written; one global lock read (one full scan) | `declining or previewing the plan applies nothing after one global lock read` |
| Any read of a legacy `state.json`, including a preview | Loader maintenance only: `state.json` migrated and its pre-migration bytes kept beside it as a backup | `declining over a legacy Library writes only the loader's backed-up migration` |
| Non-interactive setup with `--work-dir` | A separate path: the first observation itself writes `machine.json`; nothing else | `non-interactive setup with a work dir saves machine configuration while observing` |
| A selected file changes after approval, before S2 | `SetupPlanStale`; only the outside change is on disk; two global lock reads | `a selected file changed after approval fails stale before any effect` |
| S3: a later rename fails | A prefix of entries moved into recovery with their bytes; the rest untouched; the receipt records `moved: true` for the prefix only. No rollback | `a failed removal move leaves a moved prefix, the rest in place, and a receipt` |
| S3: the receipt rewrite after a move fails | The entry is moved, whole, but recorded `moved: false`. No bytes are lost. Nothing reads the receipt back, so a manual recovery must inspect both the original and recovery paths of every entry rather than trust `moved` | `a failed receipt rewrite leaves a moved copy recorded as not moved, bytes intact` (recovery-evidence characterization) |
| S4 then a later stage fails | `machine.json` created; the removals already applied stay applied | `BUG: a failed additive stage after removals leaves the removals applied` |
| An additive publication fails after its retention | Orphan originals; Library state unchanged | As above |
| S5: a later import group fails | Earlier groups stay retained and published; the failing group may leave orphan originals | Not covered here; needs a skills.sh lock fixture |
| S6/S7: a later selection fails | Earlier selections stay added, bound and projected; a bind can commit before its alias retirement | Not covered here |
| S2 passes, then a selected file changes before S6/S7 observe | The stage's fresh observation yields a new plan ID that its revalidation accepts: consent silently follows the changed bytes | `BUG: a stage's own observation refreshes consent for bytes changed after approval` |
| A selected copy changes after an earlier selection in S7 committed | Retained as changed: each selection plans from the disk as it is then | `BUG: a selected copy changed after the first additive stage is still retained` |
| Another writer commits a Library revision after approval | Apply reloads the Library per stage and builds on the new revision | `BUG: a Library change committed after approval is silently rebased onto` |
| Any approved apply | One full scan for S2, one for S4 when it runs, two each for S6 and S7, and one for S8 | `BUG: an approved apply reads the global lock once per stage's discovery scan` (five lock reads for custody alone) |
| S8 writes `machine.json` and then fails | `machine.json` updated; every earlier stage applied | Not covered here |
| S9 fails or is cancelled after a successful apply | The command fails, but nothing is undone: every stage before it is durable | Not covered here |

## Desired behaviour

The setup-apply refactor moves guided apply out of the handler into one workflow. Its target:

| Requirement | Status today |
| --- | --- |
| Exactly one full discovery scan after approval, distinct from the preview scan, asserted by an observer counter on the stable scan seam the refactor introduces (the lock-read count is only today's proxy). Cheap identity and hash checks immediately before touching bytes are still required | Violated: `BUG: an approved apply reads the global lock once per stage's discovery scan` |
| The approved plan ID stays fixed; internal re-observation never refreshes consent | Violated: `BUG: a stage's own observation refreshes consent for bytes changed after approval` |
| A stale approval, or a change after an additive stage (a selected file, lockfile, symlink target or Library revision), means no further effects and a clear stale failure | Holds before S2. Violated after it: `BUG: a selected copy changed after the first additive stage is still retained`, `BUG: a Library change committed after approval is silently rebased onto` |
| Additive stages run before removals; an additive failure means no removals | Violated: `BUG: a failed additive stage after removals leaves the removals applied` |
| If a removal fails, the durable partial state is documented and a recovery receipt is kept | Holds. When a receipt rewrite fails, the receipt can lag the disk by one move; no bytes are lost and a recovery must inspect both paths, so this is recovery evidence, not a violation |
| A concurrent Library change is never silently rebased | Violated: `BUG: a Library change committed after approval is silently rebased onto` |

In every row, current and desired, bytes that cannot be reproduced are kept: a removed copy is moved, never deleted, and the tests compare its recovered bytes and mode with the original.
