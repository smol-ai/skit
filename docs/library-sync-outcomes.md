# Library sync outcomes

This document is the test oracle for `skit sync`. It lists every path through `syncLibraryEffect` (`packages/cli/src/workflows/library/library-sync.ts`), the durable effects each path makes in order, and the outcomes a crash, a lost response, or a competing writer may legally produce at each boundary. Multi-home tests assert against these tables rather than against an informal notion of "converges".

| Coverage | Where |
| --- | --- |
| Rows that could lose data or block sync, with injected failures | `packages/cli/test/library-sync-crash.test.ts` |
| Merge properties over generated manifests | `packages/cli/test/library-merge-properties.test.ts` |
| A sync killed after the Registry commits, against the real Worker | `packages/skit-server-effect/test/e2e.test.ts` |

## Durable state

| Store | Where | Written by | Atomicity |
| --- | --- | --- | --- |
| **Remote head** | D1 `libraries.current_revision_id` + `library_revisions` | `api.write` | Compare-and-swap batch on the expected revision |
| **Remote snapshots** | R2 + D1 `library_snapshots` | `api.upload` | Content-addressed; idempotent |
| **Originals** | `<home>/originals/<digest>` | `prepareRestoreEffect` | Content-addressed; unreferenced trees are inert |
| **Local state** | `<home>/state.json`, including `sync_ancestry` | `store.publish` | Atomic rename, no fsync |
| **Projections** | Harness roots | `reconcileLibraryProjections` | Per-projection; derived from local state |

Local state and the accepted base it was reconciled with are one document ([ADR 0023](adr/0023-keep-sync-ancestry-in-library-state.md)), so no interruption can pair state with a newer base.

Notation: **L** is the local portable manifest, **R** the remote head, **B** the ancestry in `state.json`. "Orphan" means a content-addressed object that nothing references; orphans are always legal.

## Preflight

Preflight writes nothing. Each row is checked in order; the first match returns.

| Condition | Outcome |
| --- | --- |
| A retained copy's bytes no longer hash to its digest | `local_bytes_changed` |
| R has schema `skit.library.v2` | `legacy_remote_conflict` |
| B exists and (B.origin ≠ origin, or R is absent, or B.library_id ≠ R.library_id) | `base_mismatch` |
| Neither L nor R exists | `clean` (nothing written) |

Then exactly one of the paths below runs. Every path holds the home's writer lock for its whole duration when entered through `handleCommand`; `syncLibraryEffect` does not take the lock itself, so any other caller must.

## Push — R absent, L present

| Step | Effect | Commit point |
| --- | --- | --- |
| P1 | Upload each snapshot | Remote snapshots |
| P2 | `api.write(null, L)` | **Remote head** |
| P3 | Publish state with B = R' | Local state |

| Interruption | State left | Legal next outcome |
| --- | --- | --- |
| Before P2 | Orphan uploads | Push again; or, if another home pushed first, `adoption_required` |
| P2 loses the CAS | Orphan uploads; `LibraryChangedOnServer` | `adoption_required` |
| After P2, before P3, or P2's response lost | R = L, no B | `clean`, which anchors B |
| As above, and another home writes R before the retry | R ≠ L, no B | `adoption_required`; `--adopt` merges against an empty base |

## Pull — R present, L absent

| Step | Effect | Commit point |
| --- | --- | --- |
| U1 | Download snapshots; reacquire source-restorable copies | — |
| U2 | `prepareRestoreEffect` retains trees | Originals |
| U3 | Re-inspect; fail `SyncLocalChanged` if L now exists | — |
| U4 | Publish restored state with B = R | **Local state** |
| U5 | Reconcile projections | Projections |

| Interruption | State left | Legal next outcome |
| --- | --- | --- |
| Before U4 | Orphan originals | Pull again |
| U3 finds a concurrent local write | Orphan originals; `SyncLocalChanged` | Whatever the new L dictates |
| After U4, before U5 | Projections stale | `clean`, which reconciles |

## Clean — L and R are equal after normalization

Preview writes nothing. Apply publishes state with B = R, then reconciles projections. This is also how a home without ancestry anchors when it already matches the remote. Interruption between the two leaves stale projections, which the next `clean` repairs.

## Adoption gate — L and R differ, no B

Without `--adopt`: `adoption_required`, nothing written. With `--adopt`: the merge path below, with an empty base. An empty base keeps records either side holds alone and reports records both sides hold with different contents as conflicts. It never infers a deletion.

## Merge — L and R differ, B present (or `--adopt`)

Records merge three-way by identity. Global Binding intent merges per Skill and per followed Collection, and a Binding entry for a record the merge removed is dropped: removing a Collection on one device wins over enabling its Skills on another, as it would if the removal had happened second.

Resolution and conflict outcomes write nothing:

| Condition | Outcome |
| --- | --- |
| A `--take-remote` key is not a current conflict | `resolution_invalid` |
| Record, binding, custody, or manifest-invariant conflicts remain | `conflicted` |
| Preview | `merge_ready` or `adoption_ready` |

Apply:

| Step | Effect | Commit point |
| --- | --- | --- |
| M1 | Download missing snapshots; reacquire source-restorable copies | — |
| M2 | `prepareRestoreEffect` retains trees | Originals |
| M3 | Re-inspect; fail `SyncLocalChanged` if L changed | — |
| M4 | Upload snapshots the merge introduced | Remote snapshots |
| M5 | `api.write(R.revision, merged)`, skipped when merged = R | **Remote head** |
| M6 | Retire projections of bindings the merge removed | Projections, local state (B unchanged) |
| M7 | Blend restored portable state into device state; publish with B = merged | **Local state** |
| M8 | Reconcile projections | Projections |

| Interruption | State left | Legal next outcome |
| --- | --- | --- |
| Before M5 | Orphan originals and uploads | The same merge, or a new merge if R advanced |
| The process is killed after M5 commits | As the row below, plus the writer's `.lock` naming a dead PID | The next command reclaims the lock; then as below |
| M5 loses the CAS | Orphan originals and uploads; `LibraryChangedOnServer`; L, B, projections unchanged | A merge against the new R |
| After M5 (or M5's response lost), before M7 | R = merged; L and B old; some projections possibly retired | Re-merge of (B, L, merged). If merged equals L this is `clean`; otherwise it yields merged and M5 is skipped. A `--take-remote` resolution must be repeated. If another home advanced R, a genuine `conflicted` is legal. |
| After M7, before M8 | Projections stale | `clean`, which reconciles |

## Invariants every test asserts

1. **The loser of a CAS race changes no portable state.** `state.json` and owned projections are byte-identical to before; only orphans may appear.
2. **Only `pushed`, `pulled`, `merged`, and `clean` replace B, and each replaces it in the same publish as the state it reconciled.**
3. **Conflicts are non-destructive.** A `conflicted` outcome leaves every store as it was.
4. **B always describes the state that carries it.** Restoring any whole `state.json` restores its own B. A deletion is inferred only for a record B holds and L does not, which is a removal made on this home since its last reconciliation.
5. **Ordinary mutations carry B unchanged.** A local removal after sync still syncs as a removal.
6. **Quiescent convergence.** When no home edits and every home syncs until `clean`, all homes hold the same normalized portable manifest, provided every snapshot or source is available, every schema is supported, and every conflict has been resolved.
7. **Device state stays local.** Invocation policies, harness roots, and custody records survive every merge (`blendRestoredStateEffect`).
