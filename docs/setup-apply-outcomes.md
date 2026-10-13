# Setup apply outcomes

This document is the test oracle for guided `skit setup`. It lists the durable effects guided apply makes in order, the state each interruption leaves, and the behaviour it must keep. `setupCommand` (`packages/cli/src/handlers/library/setup.ts`) previews, asks, and hands the approved plan to `applySetupPlan` (`packages/cli/src/workflows/library/setup-apply.ts`), which owns the apply sequence. It has two parts: **current behaviour**, traced from source and pinned by tests, and **desired behaviour**, the requirements every change must keep.

| Coverage | Where |
| --- | --- |
| Consent, staleness, ordering, partial failure, and scan counts of guided apply, with lossless disk snapshots | `packages/cli/test/setup-apply-outcomes.test.ts` |
| Lossless snapshot of declared roots (type, mode, link target, bytes) and its self-test | `packages/cli/test/helpers/disk-snapshot.ts`, `packages/cli/test/disk-snapshot.test.ts` |
| Removal previews, archive layout, linked sources, and stale removal plans | `packages/cli/test/setup-removal.test.ts` |
| skills.sh lock adoption and observed-source imports | `packages/cli/test/setup-lock-source-adoption.test.ts` |
| Local custody, alias retirement, and duplicate choices | `packages/cli/test/setup-local-custody.test.ts`, `packages/cli/test/setup-discovered-copies.test.ts` |

The acceptance tests drive `setupCommand` itself with `interactive: true`, a scripted prompter and renderer (`makeScriptedInteraction`), a real temporary filesystem and real Library services. `skit setup --json` cannot reach guided apply: it forces a dry run. Tests assert the typed `Exit`, validate a successful `SetupResult` against `outputContracts.setup`, and compare `captureDisk` snapshots of the Library home, the agent roots with their backups, and the skills.sh state directory. Scans are counted at the scan seam: every full discovery scan goes through the `SetupDiscovery` reference (`packages/cli/src/workflows/library/setup-discovery.ts`), and the tests wrap it with a counter, in all and after approval. Changes "after approval" and "after the first additive stage" are made at explicit gates (the approving prompt, the first Library publication, a named rename), never after a delay.

## Durable state

| Store | Where | Written by | Atomicity |
| --- | --- | --- | --- |
| **Machine config** | `<home>/machine.json` | `saveSetupMachineConfig`, whenever `runSetup` runs with `persistRoots` and in apply stage S3 | Atomic rename, under the configuration writer |
| **Library state** | `<home>/state.json` | Each import, add, and bind publication | Atomic rename, compare-and-swap against the loaded base, under the Library writer |
| **Migration backup** | `<home>/state.json.v<N>.backup-<time>` | The state loader, on first read of a legacy state | Atomic rename; the migrated state is written after it |
| **Originals** | `<home>/originals/<digest>` | Retention, before the state that references it | Content-addressed; unreferenced trees are inert |
| **Recovery folder** | `<home>/removed/<uuid>/` with `receipt.json` | `applySetupRemovals` | Per-entry rename; the receipt is rewritten atomically after each |
| **Agent roots** | Harness skills roots and their `.skit-backups` | Removals (move out), binds (managed projection replaces the copy) | Per entry |

## Current behaviour

### Stages

Preview runs without the Library writer lock. On approval, `applySetupPlan` runs every stage inside one `withLibraryWriter`. No stage observes again: each works from the S2 scan and checks the identity of what it touches immediately before touching it.

| Step | Effect | Source |
| --- | --- | --- |
| S0 | Preview: `runSetup` with `persistRoots: false`, plus a second observation if repository decisions were asked. The plan ID covers the candidates, the instances, the repository configs and the Library revision | handler `setupCommand`; `workflows/library/setup.ts` `observeSetup` |
| S1 | Confirmation prompt; declining returns the preview | handler `setupCommand` |
| S2 | The one apply-time scan, held to the approved plan ID | `setup-apply.ts`; `workflows/library/setup.ts` `revalidateSetupPlan` |
| S3 | If the plan saves roots, or imports or adds without a machine identity: write `machine.json`, without scanning | `setup-apply.ts`; `setup-discovery.ts` `saveSetupMachineConfig` |
| S4 | Observed-source imports, one Collection group at a time, each retained and published before the next; each lockfile's hash is checked first | `setup-observed-collections.ts` |
| S5 | Existing-entry binds: per selection bind and project against the approved content hash, then retire aliases | `setup-existing-binding.ts`; `setup-local-custody.ts` `bindSetupCopy` |
| S6 | Local custody: per selection, check the copy still hashes to its approved identity, then `addLibrarySourceEffect`, bind and project, then retire aliases | `setup-local-custody.ts` |
| S7 | Explicit removals, last: check the Library is still at the apply's revision, preflight every entry (identity and link target; for a directory also its approved content hash and no new custody marker), create the recovery folder, write the receipt, then for each entry check it again, rename it, and rewrite the receipt | `setup-apply.ts`; `setup-removal.ts` |
| S8 | Outside the writer: offer a skills.sh update check, which loads the Library and may prompt | handler `offerSkillsShUpdateCheck` |

During S3 to S6 every Library publication must build on the approved revision or on the apply's own previous publication; any other base fails with `LibraryChanged`, which a binding stage reports as its own conflict. There is no closing verification scan: a guided apply returns the S2 observation with the saved machine configuration, and guided setup does not render it.

### Rows

| Condition | State left | Test |
| --- | --- | --- |
| Guided preview declined, or a dry run | Nothing written; one scan | `declining or previewing the plan applies nothing after one scan` |
| Any read of a legacy `state.json`, including a preview | Loader maintenance only: `state.json` migrated and its pre-migration bytes kept beside it as a backup | `declining over a legacy Library writes only the loader's backed-up migration` |
| Non-interactive setup with `--work-dir` | A separate path: the first observation itself writes `machine.json`; nothing else; one scan | `non-interactive setup with a work dir saves machine configuration while observing` |
| Any approved apply | One scan after approval, however many stages run | `an approved apply scans once after approval, whatever stages it runs` |
| A selected file changes after approval, before S2 | `SetupPlanStale`; only the outside change is on disk | `a selected file changed after approval fails stale before any effect` |
| Another writer commits a Library revision after approval, before S2 | `SetupPlanStale`; only the outside change is in the Library | `a Library change committed after approval fails stale before any effect` |
| A selected copy changes after S2, before its custody stage | `PlanIsStale`; `machine.json` may be written; nothing retained, nothing removed | `bytes changed between the apply-time scan and a later stage fail stale` |
| A selected copy changes after an earlier selection committed | `PlanIsStale`; earlier selections stay added; the changed copy is not retained; nothing removed | `a selected copy changed after the first additive stage fails stale` |
| Another writer commits a Library revision between stages | A conflict failure at the next publication; earlier publications stay; nothing further is published or removed | `a Library change committed after the first additive stage stops the apply` |
| A removal selection is edited in place after the apply-time scan | `PlanIsStale`; earlier additive stages stay; the edited copy stays where it is, nothing removed | `a removal selection edited after the first additive stage stays in place` |
| An additive stage fails | `machine.json` and orphan originals may be written; the failed publication changes nothing; no removal applied | `a failed additive stage leaves every selected removal in place` |
| S4: a later import group fails | Earlier groups stay retained and published; the failing group may leave orphan originals | Not covered here; needs a skills.sh lock fixture |
| S5/S6: a later selection fails | Earlier selections stay added, bound and projected; a bind can commit before its alias retirement | Not covered here |
| S7: a later rename fails | Every additive stage applied; a prefix of entries moved into recovery with their bytes; the rest untouched; the receipt records `moved: true` for the prefix only. No rollback | `a failed removal move leaves a moved prefix, the rest in place, and a receipt` |
| A removal selection gains a custody marker, even an invalid one, after the apply-time scan | `PlanIsStale`; earlier additive stages stay; the copy stays where it is with its bytes, nothing removed. The tree hash excludes the marker, so this is checked on its own | `a removal selection that gains a custody marker after the scan stays in place` |
| S7: a later entry is replaced while an earlier one moves | `PlanIsStale`; the earlier entry is in recovery and recorded `moved: true`; the replaced entry is untouched and recorded `moved: false` | `a removal entry replaced during an earlier move stays untouched` |
| S7: the receipt rewrite after a move fails | The entry is moved, whole, but recorded `moved: false`. No bytes are lost. Nothing reads the receipt back, so a manual recovery must inspect both the original and recovery paths of every entry rather than trust `moved` | `a failed receipt rewrite leaves a moved copy recorded as not moved, bytes intact` (recovery-evidence characterization) |
| S8 fails or is cancelled after a successful apply | The command fails, but nothing is undone: every stage before it is durable | Not covered here |

## Desired behaviour

Guided apply lives in one workflow. Every requirement holds today:

| Requirement | Held by |
| --- | --- |
| Exactly one full discovery scan after approval, distinct from the preview scan, counted at the `SetupDiscovery` seam. Cheap identity and hash checks immediately before touching bytes are still required | `an approved apply scans once after approval, whatever stages it runs`; the S4 to S7 checks |
| The approved plan ID stays fixed; internal re-observation never refreshes consent | `a selected file changed after approval fails stale before any effect`, `bytes changed between the apply-time scan and a later stage fail stale` |
| A stale approval, or a change after an additive stage (a selected file, lockfile, symlink target or Library revision), means no further effects and a clear stale failure | `a selected copy changed after the first additive stage fails stale`, `a Library change committed after the first additive stage stops the apply`, `a removal selection edited after the first additive stage stays in place`, `a removal selection that gains a custody marker after the scan stays in place`, `a removal entry replaced during an earlier move stays untouched`; lockfiles in `setup-lock-source-adoption.test.ts`, symlink targets in `harness-shadows.test.ts` |
| Additive stages run before removals; an additive failure means no removals | `a failed additive stage leaves every selected removal in place` |
| If a removal fails, the durable partial state is documented and a recovery receipt is kept | The two S7 rows. When a receipt rewrite fails, the receipt can lag the disk by one move; no bytes are lost and a recovery must inspect both paths, so this is recovery evidence, not a violation |
| A concurrent Library change is never silently rebased | `a Library change committed after approval fails stale before any effect`, `a Library change committed after the first additive stage stops the apply` |

In every row, current and desired, bytes that cannot be reproduced are kept: a removed copy is moved, never deleted, and the tests compare its recovered bytes and mode with the original.
