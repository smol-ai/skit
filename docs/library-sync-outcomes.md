# Library sync outcomes

This document is the test oracle for `skit sync`. It lists every path through `syncLibraryEffect` (`packages/cli/src/workflows/library/library-sync.ts`), the durable effects each path makes in order, and the outcomes a crash, a lost response, or a competing writer may legally produce at each boundary. Multi-home tests assert against these tables rather than against an informal notion of "converges".

| Coverage | Where |
| --- | --- |
| Named preflight, push, pull, and merge fault rows; byte-level state and projection checks; the commit order of every applying path; `--take-remote` refused before collision checks; edited copies recorded before reconciliation | `packages/cli/test/library-sync-outcomes.test.ts` |
| Lost response on a later push, restored older state, ancestry, removals, device policies, every declared device field through push, merge and clean, and undeclared fields | `packages/cli/test/library-sync-crash.test.ts` |
| Projection custody, collision resolution, identity retirement, and interrupted adoption | `packages/cli/test/library-sync-edge-cases.test.ts` |
| Stale bases, retries of a committed manifest, and snapshot readiness/reuse, on real D1 and on the client fake | `packages/skit-server-effect/test/library-sync.test.ts`, `packages/cli/test/library-sync-server.test.ts` |
| Merge properties over generated manifests | `packages/cli/test/library-merge-properties.test.ts` |
| Hand-derived alias cases: the same upstream under different Collection IDs (with device policy, repository Binding, projection and ancestry remapping), distinct upstreams with identical bytes, an equal artifact digest with a different validation digest, many homes converging on one identity, `local_version_id`, and a divergent import with and without a takeable remote choice | `packages/cli/test/library-sync-aliases.test.ts` |
| Independently constructed conflict-free and conflicting merge families, including aligned-import families (same selection, older local history, equal artifact with a different source digest, a selected retained edit), alone and in combination | `packages/cli/test/library-merge-families.test.ts` |
| Absent versus empty remote, absent versus empty local state, an empty accepted base, and no-op syncs that publish nothing locally and send no Registry write | `packages/cli/test/library-sync-absence.test.ts` |
| Literal supported-wire bodies decoded and encoded by the client; a literal newer head and receipt refused | `packages/cli/test/library-sync-wire.test.ts` |
| A sync killed after the Registry commits, and two homes racing with independent additions | `packages/skit-server-effect/test/e2e.test.ts` |

The outcome matrix checks stopped operations against the row's permitted durable state and retries against the next legal outcome. It covers `local_bytes_changed`, legacy remote rejection, ancestry mismatch, first-push CAS loss, first-push lost responses (including a subsequent competing write), both `SyncLocalChanged` guards (including a merge and a `--keep-enabled` pull that would otherwise upload or write), merge CAS loss, failures before local publication, repeated `--take-remote`, and projection failures after publication. A lost response on a later push is covered by the existing crash suite rather than duplicated in the matrix.

**Known bug characterization:** `local_bytes_changed` reports that sync stopped but the CLI exits `0`. `packages/cli/test/library-sync-local-bytes.e2e.test.ts` belongs to the subprocess suite and asserts that current status and structured outcome with a BUG comment requiring a nonzero exit when fixed. The ordinary in-process matrix row separately checks unchanged state/projection bytes and remote storage. There is no expected-failure mask.

An applied `clean` sync of a home whose ancestry already names the head publishes nothing and sends no Registry write request. `packages/cli/test/library-sync-absence.test.ts` measures writes directly: the test devices count every `LibraryStore.publish` call and the fake Registry counts every write request it receives, separately from the revisions it commits, so an identical rewrite in place or an idempotent write answered with the head is still counted. Anchoring is not a no-op: an applied `clean` of an empty Library without ancestry over an empty remote is pinned at one publication and no write requests, and every other no-op row (each preview, `base_mismatch`, `adoption_required`, absent R with absent L, and an anchored clean) at zero of both. Lossless snapshots with file identity (`captureDisk(roots, { identity: true })`) are complementary durable-state evidence. They cannot prove or disprove a rewrite, because a filesystem may hand the replaced inode number to the next temporary file.

The client fake (`packages/cli/test/helpers/library-sync-server.ts`) encodes every response with the core Library sync contract schemas the Worker uses, so status codes and bodies cannot drift; its compare-and-swap rules are asserted separately against the Worker. Faults are one typed union injected per test and consumed once at the boundary they target. Lost write responses are injected as transport failures after the fake commits, yielding `LibraryApiUnreachable`. An explicit HTTP `500` after commit yields the different `LibraryApiRejected` path; both are characterized. The existing crash and adoption-custody lost-response tests now use the transport fault. The concurrent-local-write hook fires when the fake serves the head GET, between the client's local inspection and publication, rather than counting internal inspections. Projection failure rows assert a failed first sync and recover the Skill bytes at the same interrupted root. The fake also records, in order, each snapshot upload, each Library write with the revision it names as its base, and each local publication, so the commit order is asserted as a sequence.

## Worker endpoint characterization

`packages/skit-server-effect/test/library-sync.test.ts` exercises the Worker fetch handler on real D1 and R2 initialized from committed migrations. An extracted conditional commit is tested after a direct D1 head advance, bypassing the application precheck: it rejects the stale base and leaves revision rows, head, and R2 bytes unchanged. A concurrent HTTP submission test is only a smoke test; it does not prove D1 atomicity. Stale requests return `409`. A manifest requiring an unuploaded snapshot is rejected (`400`) without adding a revision. Tests inspect revision parentage, snapshot rows, stored archive bytes, and R2 metadata after accepted and rejected writes.

If a committed write's response is lost, immediately retrying with its original expected revision returns `409`, including a first write with a null base. Reading the current head and submitting the identical manifest with that revision returns `200` without adding a revision or changing stored snapshots.

`/api/library/portable` is the only Library head API; the server no longer accepts or serves `skit.library.v2` manifests. A v2 revision already stored as a head is not rewritten: the portable GET fails with `500` and the client stops before writing anything.

## Remote manifest version

The client reads a successful head response's `manifest.schema` from the raw body before decoding the manifest, and only that field. A schema of the form `skit.library.v<N>` with N newer than the manifest schema this CLI supports fails with `LibraryManifestTooNew` (`VALIDATION_FAILED`), naming the observed and supported schemas and asking for an upgrade. A missing, foreign or malformed schema is `LibraryApiInvalidResponse`, as is a supported or older one the full decode rejects. The server's build and discovery document are not compatibility signals. The same check applies to the receipt of a successful write, where it diagnoses the response but cannot undo the write.

The refusal comes from the head read, so it happens before sync plans, uploads, writes or publishes anything: zero local publications, zero Registry write requests (uploads included) and no remote change, for a preview or an apply, whether the home is current, legacy or absent. Loader maintenance that precedes the read is permitted and is the only durable change: taking the writer lock creates an absent home, and opening a legacy `state.json` migrates it in place and keeps the pre-migration file as `state.json.v<N>.backup-<time>`. A retained copy whose bytes changed is still reported first as `local_bytes_changed`, because local verification precedes the head read. `packages/cli/test/library-sync-outcomes.test.ts` pins this with a literal `skit.library.v8` head for each home and mode.

## One pipeline

Every path is the same three-way merge of L with R from B. A push merges L with an absent R against an empty base, a pull an absent L with R, and a clean sync is a merge whose result is both sides. Absent and empty stay distinct facts: only two existing Libraries can be clean or need adoption, and only an absent R is created by the write, so an empty L still pushes. One alias map, of Collection, Skill and Version handles, is computed once and applied to L, B and the device state at one site. A `--take-remote` key must name a conflict the merge can take remotely; it is checked before projection collisions on every path, so a push or a pull, which has no merge conflicts, refuses any key with `resolution_invalid`. A pull plans no device Projections, because an empty device has none and planning it would only report remote Bindings without a selected Version.

Every applying path commits in one order, stated once in `syncLibraryEffect`:

1. Retain every copy the result references in originals (downloading and reacquiring what is missing).
2. Upload every snapshot the new head references that R lacks.
3. Write the head by compare-and-swap on the revision this sync read, skipped when the result equals an existing R.
4. Retire the Projections the plan removes or reidentifies.
5. Publish local state, with ancestry naming exactly the written revision, onto exactly the state this sync planned from.
6. Reconcile Projections.

Remote commits before local, so an interruption leaves R ahead of B and the next sync re-derives the same result from the old base; local state never names a revision R does not hold. A merge or pull re-inspects L after step 1 and stops with `SyncLocalChanged` if it moved; a push relies on the check in step 5. A clean sync has nothing to commit: it skips steps 1–4, publishes only when its state's ancestry does not already name R, and then reconciles.

Sync rebuilds the device state it publishes through the Library schema, so it carries only fields this CLI declares. Loading and publishing `state.json` keep undeclared fields at every depth, and a preview or a clean sync with nothing to anchor writes nothing, but an applied push, pull, merge or anchoring clean drops them. Any persisted field whose meaning matters must therefore come with a state or manifest version bump, never as an undeclared extension.

### Differences from the four earlier paths

The unification is not behaviour-identical. These differences are intended, and `packages/cli/test` pins each:

| Difference | Before | Now |
| --- | --- | --- |
| Undeclared state fields | A push and a clean anchor kept them; a merge dropped them | Every applied publication drops them |
| An edited copy whose Version a push changes | Published as `installed` with its old digest until reconciliation | Published `conflicted` with its observed digest at step 5, as a merge does |
| An applied clean of an anchored home | Published identical state twice | Publishes nothing and does not enter sync's retirement step |
| Reconciliation that changes nothing | Published identical state | Publishes nothing ([projection batches](#durable-state)) |
| A head in a newer manifest schema | `LibraryApiInvalidResponse` | `LibraryManifestTooNew` before any write ([Remote manifest version](#remote-manifest-version)) |
| Record order of a pushed manifest and the state it anchors | L's order | The merge's normalized order, as a merge already wrote |

## Durable state

| Store | Where | Written by | Atomicity |
| --- | --- | --- | --- |
| **Remote head** | D1 `libraries.current_revision_id` + `library_revisions` | `api.write` | Compare-and-swap batch on the expected revision |
| **Remote snapshots** | R2 + D1 `library_snapshots` | `api.upload` | Content-addressed; idempotent |
| **Originals** | `<home>/originals/<digest>` | `prepareRestoreEffect` | Content-addressed; unreferenced trees are inert |
| **Local state** | `<home>/state.json`, including `sync_ancestry` | `store.publish` | Atomic rename, no fsync |
| **Projections** | Harness roots | `reconcileLibraryProjections` | Per-projection; derived from local state |

A projection batch whose state is unchanged, which wrote nothing and has no pending backup to settle, publishes nothing. A batch with backups to settle publishes onto the state it loaded first, so a backup is never judged against a state the Library has moved on from.

Local state and the accepted base it was reconciled with are one document ([ADR 0023](adr/0023-keep-sync-ancestry-in-library-state.md)), so no interruption can pair state with a newer base.

Notation: **L** is the local portable manifest, **R** the remote head, **B** the ancestry in `state.json`. "Orphan" means a content-addressed object that nothing references; orphans are always legal.

## Preflight

Preflight writes nothing beyond the loader maintenance described under [Remote manifest version](#remote-manifest-version). Each row is checked in order; the first match returns.

| Condition | Outcome |
| --- | --- |
| A retained copy's bytes no longer hash to its digest | `local_bytes_changed` |
| R's manifest schema is newer than this CLI supports | `LibraryManifestTooNew` (see [Remote manifest version](#remote-manifest-version)) |
| B exists and (B.origin ≠ origin, or R is absent, or B.library_id ≠ R.library_id), without `--adopt` | `base_mismatch` |
| Neither L nor R exists | `clean` (nothing written) |

With `--adopt`, mismatched ancestry is set aside and sync continues as if B were absent, so the merge can only add records. Then exactly one of the paths below runs. Every applying path holds the home's writer lock for its whole duration: `syncLibraryEffect` acquires it when applying, and reuses it reentrantly when its caller already holds it. Each local publish is also checked against the local state the path planned from: if that state has changed, which only a caller without the writer lock can allow, the publish is refused with `SyncLocalChanged` and changes no local state.

Every ready/apply path also checks enabled destinations using filesystem identity and previews affected projection custody before committing. A collision reports the Skill IDs and Collection labels. `--keep-enabled <skill-id>` keeps one competing Skill enabled and retains the others without enabling them; invalid or competing choices return `resolution_invalid`. Modified copies and repository Bindings that would lose their selected entities report device conflicts with specific remediation. These checks are read-only.

Independent imports of the same upstream and tracking configuration adopt the published Collection identity; Skills match by source path within that Collection. New Skills independently discovered at the same path of an existing Collection also align. Matching names across different Sources never align identities. Equivalent Version handles then align as usual. Compatible histories and their Acquisition provenance are combined. Divergent independent observations whose remote selection follows the Source, or whose current membership differs, require a Collection conflict choice. Taking remote adopts its Collection observation graph and Version history, without pinning a Source Version as a local edit; strictly older local Acquisitions stay retained. Equal timestamps do not establish precedence. This choice is unavailable if local has a selected edit or any discarded Acquisition cannot be restored from a pinned Source revision. Rejected originals remain on disk. Ordinary updates to edited projections preserve the edited bytes and report the projection conflict during reconciliation; inactive edited copies also remain non-blocking while their references stay valid.

## Push — R absent, L present

| Step | Effect | Commit point |
| --- | --- | --- |
| P0 | `prepareRestoreEffect` re-verifies L's retained copies | Originals (already present) |
| P1 | Upload each snapshot | Remote snapshots |
| P2 | `api.write(null, L)` | **Remote head** |
| P3 | Retire intact copies the Binding choice removes | Projections, local state (B unchanged) |
| P4 | Publish state with B = R', recording edited copies as `conflicted` with their observed digest | Local state |
| P5 | Reconcile global and existing repository projections | Projections |

| Interruption | State left | Legal next outcome |
| --- | --- | --- |
| Before P2 | Orphan uploads | Push again; or, if another home pushed first, `adoption_required` |
| P2 loses the CAS | Orphan uploads; `LibraryChangedOnServer` | `adoption_required` |
| After P2, before P4, or P2's response lost | R = desired, no B | `clean` if L = R; otherwise `--adopt` with the same Binding choice |
| As above, and another home writes R before the retry | R ≠ L, no B | `adoption_required`; `--adopt` merges against an empty base |
| P3 or P4 is refused because L changed since the plan | R = desired, no B; `SyncLocalChanged`; L as the other writer left it | As after P2, before P4, against the new L |
| After P4, before P5 | Projections stale | `clean`, which reconciles |

## Pull — R present, L absent

| Step | Effect | Commit point |
| --- | --- | --- |
| U1 | Download snapshots; reacquire source-restorable copies | — |
| U2 | `prepareRestoreEffect` retains trees | Originals |
| U3 | Re-inspect; fail `SyncLocalChanged` if L now exists | — |
| U4 | Publish restored state with B = R | **Local state** |
| U5 | Reconcile global projections | Projections |

| Interruption | State left | Legal next outcome |
| --- | --- | --- |
| Before U4 | Orphan originals | Pull again |
| U3 finds a concurrent local write, or U4 is refused because L now exists | Orphan originals; `SyncLocalChanged` | Whatever the new L dictates |
| After U4, before U5 | Projections stale | `clean`, which reconciles |

When `--keep-enabled` changes the pulled Binding, a CAS write of that choice occurs after U3 and before U4, and U4 anchors the resulting revision. A lost response leaves no local state; the next pull reads the already-resolved head. A CAS loser publishes no state and touches no projections.

## Clean — L and R are equal after normalization

Preview writes nothing. Apply transfers, writes and retires nothing. It publishes only when the state's ancestry does not already name R: it then publishes the state with B = R, and if L changed after it was compared with R, the publish is refused with `SyncLocalChanged` and B is unchanged. This is how a home without ancestry anchors when it already matches the remote. An anchored home publishes nothing and sends no write request. Either way it then reconciles projections, which publishes only what it changes. Interruption between anchoring and reconciliation leaves stale projections, which the next `clean` repairs.

## Adoption gate — L and R differ, no B

Without `--adopt`: `adoption_required`, nothing written. With `--adopt`: the merge path below, with an empty base. An empty base keeps records either side holds alone and reports records both sides hold with different contents as conflicts. It never infers a deletion.

## Merge — L and R differ, B present (or `--adopt`)

Records merge three-way by identity. Global Binding intent merges per Skill and per followed Collection, and a Binding entry for a record the merge removed is dropped: removing a Collection on one device wins over enabling its Skills on another, as it would if the removal had happened second.

A Collection removal concurrent with changes to its Skills or Acquisitions is one `collection:<id>` conflict. Taking remote chooses the remote Collection, its dependent records and its Binding contribution together, including remote deletion. Retained copies stay while another surviving Acquisition references them. Invalid merged records carry the Schema diagnostic naming the broken references; `manifest:invariants` is diagnostic-only and cannot be passed to `--take-remote`.

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
| M6 | Retire preflighted removed or reidentified projections; persist pending intent before reidentification retirement | Projections, local state (B unchanged) |
| M7 | Blend restored portable state into the aliased device state; publish with B = merged | **Local state** |
| M8 | Reconcile global and existing repository projections | Projections |

| Interruption | State left | Legal next outcome |
| --- | --- | --- |
| Before M5 | Orphan originals and uploads | The same merge, or a new merge if R advanced |
| The process is killed after M5 commits | As the row below, plus the writer's `.lock` naming the dead process | Later commands that need the writer lock fail `LibraryBusy`, naming the lock and its recorded owner; reads still work. Once that process is confirmed stopped, remove the lock by hand; then as below |
| M5 loses the CAS | Orphan originals and uploads; `LibraryChangedOnServer`; L, B, projections unchanged | A merge against the new R |
| After M5 (or M5's response lost), before M7 | R = merged; L and B old; some projections possibly retired | Re-merge of (B, L, merged). If merged equals L this is `clean`; otherwise it yields merged and M5 is skipped. A `--take-remote` resolution must be repeated. If another home advanced R, a genuine `conflicted` is legal. |
| M6 or M7 is refused because L changed since the plan | R = merged; L as the other writer left it, B old; `SyncLocalChanged` | As after M5, before M7, against the new L |
| After M7, before M8 | Projections stale | `clean`, which reconciles |

An intact projection whose previous Version is dropped by a remote Skill choice is carried into M7 with the merged selected Version, preserving its projection ID, expected digest and repository root. M8 then rewrites it under ordinary marker/hash custody checks. A reidentified Skill instead retires its old on-disk identity at M6; its old state references remain valid until M7. Pending missing copies remain pending during inventory scans and are recreated on retry. Native-deletion suppression is carried through identity alignment.

## Safety invariants and their coverage

These are obligations of sync, not a claim that every existing test asserts all seven. The fault matrix captures each home, its projection root and their backups with the lossless `captureDisk` snapshot (`packages/cli/test/helpers/disk-snapshot.ts`) and asserts an empty diff where the row forbids local writes, or only orphan originals where the row permits them. Taking the writer lock creates a home that did not exist yet; the rows permit that directory itself, and the absent/empty matrix requires it to stay empty. The absence matrix also counts local publications and Registry write requests, which must stay unchanged on every no-op row, and captures file identity as complementary evidence; the counters, not identity, prove a write did or did not happen. The concurrent-local-write rows instead compare the new writer's exact state bytes and preserve existing projection bytes. Publication and recovery rows assert ancestry and retained records. The crash, custody, version-alignment, and merge-property suites cover the additional cases listed above; generated manifest merge properties do not constitute an exhaustive model of device synchronization.

1. **The loser of a CAS race changes no portable state.** `state.json` and owned projections are byte-identical to before; only orphans may appear.
2. **Only `pushed`, `pulled`, `merged`, and `clean` replace B, and each replaces it in the same publish as the state it reconciled.**
3. **Conflicts are non-destructive.** A `conflicted` outcome leaves every store as it was.
4. **B always describes the state that carries it.** Restoring any whole `state.json` restores its own B. A deletion is inferred only for a record B holds and L does not, which is a removal made on this home since its last reconciliation.
5. **Ordinary mutations carry B unchanged.** A local removal after sync still syncs as a removal.
6. **Quiescent convergence.** When no home edits and every home syncs until `clean`, all homes hold the same normalized portable manifest, provided every snapshot or source is available, every schema is supported, and every conflict has been resolved.
7. **Device state stays local.** Invocation policies, harness roots, and custody records survive every merge (`blendRestoredStateEffect`).
