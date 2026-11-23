# Library sync outcomes

This document is the test oracle for `skit sync`. It lists every path through `syncLibrary` (`packages/skit/src/library/internal/sync/library-sync.ts`), the durable effects each path makes in order, and the outcomes a crash, a lost response, or a competing writer may legally produce at each boundary. Multi-home tests assert against these tables rather than against an informal notion of "converges".

| Coverage | Where |
| --- | --- |
| Named preflight, push, pull, and merge fault rows; byte-level state and projection checks; the commit order of every applying path; `--take-remote` refused before collision checks; edited copies recorded before reconciliation | `packages/cli/test/library-sync-outcomes.test.ts` |
| Lost response on a later push, restored older state, ancestry, removals, device policies, every declared device field through push, merge and clean, and undeclared fields | `packages/cli/test/library-sync-crash.test.ts` |
| Projection custody, collision resolution, identity retirement, and recorded local Sync recovery | `packages/cli/test/library-sync-edge-cases.test.ts` |
| Stale bases, retries of a committed manifest, and snapshot readiness/reuse, on real D1 and on the client fake | `packages/skit-server-effect/test/library-sync.test.ts`, `packages/cli/test/library-sync-server.test.ts` |
| Merge properties over generated manifests | `packages/skit/test/library-merge-properties.test.ts` |
| Hand-derived alias cases: the same upstream under different Collection IDs (with device policy, repository Binding, projection and ancestry remapping), distinct upstreams with identical bytes, an equal artifact digest with a different validation digest, many homes converging on one identity, `local_version_id`, and a divergent import with and without a takeable remote choice | `packages/cli/test/library-sync-aliases.test.ts` |
| Independently constructed conflict-free and conflicting merge families, including aligned-import families (same selection, older local history, equal artifact with a different source digest, a selected retained edit), alone and in combination | `packages/skit/test/library-merge-families.test.ts` |
| Absent versus empty remote, absent versus empty local state, an empty accepted base, and no-op syncs that publish nothing locally and send no Registry write | `packages/cli/test/library-sync-absence.test.ts` |
| Literal supported-wire bodies decoded and encoded by the client; a literal newer head and receipt refused | `packages/cli/test/library-sync-wire.test.ts` |
| A sync killed after the Registry commits, and two homes racing with independent additions | `packages/skit-server-effect/test/e2e.test.ts` |

The outcome matrix checks stopped operations against the row's permitted durable state and retries against the next legal outcome. It covers `local_bytes_changed`, legacy remote rejection, empty-base first connections and changed-Library previews, first-push CAS loss, first-push lost responses (including a subsequent competing write), both `SyncLocalChanged` guards (including a merge and a `--keep-enabled` pull that would otherwise upload or write), merge CAS loss, failures before local publication, repeated `--take-remote`, and projection failures after publication. A lost response on a later push is covered by the existing crash suite rather than duplicated in the matrix.

A `local_bytes_changed` stop exits `1`, with the structured outcome unchanged. `packages/cli/test/library-sync-local-bytes.e2e.test.ts` checks the real CLI process status and unchanged disk state; the in-process matrix separately checks unchanged state/projection bytes and remote storage.

An applied `clean` sync of a home whose ancestry already names the head publishes nothing and sends no Registry write request. `packages/cli/test/library-sync-absence.test.ts` measures writes directly: the test devices count every change of the Library's state revision, observed at writable opens and when each device operation completes, and the fake Registry counts every write request it receives, separately from the revisions it commits, so an idempotent write answered with the head is still counted. A transaction that saves identical state does not change the revision and is not counted. Anchoring is not a no-op: an applied `clean` of an empty Library without ancestry over an empty remote is pinned at one publication and no write requests, and every other no-op row (each preview, absent R with absent L, and an anchored clean) at zero of both. Lossless snapshots with file identity (`captureDisk(roots, { identity: true })`) are complementary durable-state evidence. They cannot prove or disprove a rewrite, because a filesystem may hand the replaced inode number to the next temporary file.

The client fake (`packages/cli/test/helpers/library-sync-server.ts`) encodes every response with the core Library sync contract schemas the Worker uses, so status codes and bodies cannot drift; its compare-and-swap rules are asserted separately against the Worker. Faults are one typed union injected per test and consumed once at the boundary they target. Lost write responses are injected as transport failures after the fake commits, yielding `LibraryApiUnreachable`. An explicit HTTP `500` after commit yields the different `LibraryApiRejected` path; both are characterized. The existing crash and adoption-custody lost-response tests now use the transport fault. The concurrent-local-write hook fires when the fake serves the head GET, between the client's local inspection and publication, rather than counting internal inspections. Projection failure rows assert a failed first sync and recover the Skill bytes at the same interrupted root. The fake also records, in order, each snapshot upload, each Library write with the revision it names as its base, and each local publication, so the commit order is asserted as a sequence.

## Worker endpoint characterization

`packages/skit-server-effect/test/library-sync.test.ts` exercises the Worker fetch handler on real D1 and R2 initialized from committed migrations. An extracted conditional commit is tested after a direct D1 head advance, bypassing the application precheck: it rejects the stale base and leaves revision rows, head, and R2 bytes unchanged. A concurrent HTTP submission test is only a smoke test; it does not prove D1 atomicity. Stale requests return `409`. A manifest requiring an unuploaded snapshot is rejected (`400`) without adding a revision. Tests inspect revision parentage, snapshot rows, stored archive bytes, and R2 metadata after accepted and rejected writes.

If a committed write's response is lost, immediately retrying with its original expected revision returns `409`, including a first write with a null base. Reading the current head and submitting the identical manifest with that revision returns `200` without adding a revision or changing stored snapshots.

`/api/library/portable` is the only Library head API; the server no longer accepts or serves `skit.library.v2` manifests. A v2 revision already stored as a head is not rewritten: the portable GET fails with `500` and the client stops before writing anything.

## Remote manifest version

The client reads a successful head response's `manifest.schema` from the raw body before decoding the manifest, and only that field. A schema of the form `skit.library.v<N>` with N newer than the manifest schema this CLI supports fails with `LibraryManifestTooNew` (`VALIDATION_FAILED`), naming the observed and supported schemas and asking for an upgrade. A missing, foreign or malformed schema is `LibraryApiInvalidResponse`, as is a supported or older one the full decode rejects. The server's build and discovery document are not compatibility signals. The same check applies to the receipt of a successful write, where it diagnoses the response but cannot undo the write.

The refusal comes from the head read, so it happens before sync plans, uploads, writes or publishes anything: zero local publications, zero Registry write requests (uploads included) and no remote change, for a preview or an apply, whether the home is current, legacy or absent. Loader maintenance that precedes the read is permitted and is the only durable change: taking the writer lock creates an absent home, and opening a home that still holds a released `state.json` imports it once into `library.sqlite`, keeps the original as `state.json.v<N>.backup-database` and leaves `state.json` as a newer-version stub. A retained copy whose bytes changed is still reported first as `local_bytes_changed`, because local verification precedes the head read. `packages/cli/test/library-sync-outcomes.test.ts` pins this with a literal `skit.library.v8` head for each home and mode.

## One pipeline

Every path is the same three-way merge of L with R from B. A push merges L with an absent R against an empty base, a pull an absent L with R, and a clean sync is a merge whose result is both sides. Absent and empty stay distinct facts: only two existing Libraries can be clean, and only an absent R is created by the write, so an empty L still pushes. Library aligns Collection, Skill and Version handles in the review and revalidates the prepared local program against the reviewed snapshot. A `--take-remote` key must name a conflict the merge can take remotely; it is checked before projection collisions on every path, so a push or a pull, which has no merge conflicts, refuses any key with `resolution_invalid`. A pull plans no device Projections, because an empty device has none and planning it would only report remote Bindings without a selected Version.

`openSyncSession` in Library owns ancestry/base choice, portable merge, identity alignment, device selection, destination checks and change summaries. Its reviewed target and facts are copies. Library's `syncLibrary` owns transfer ordering and bounded contention retries; the CLI supplies the Registry transport, progress and formatting.

```text
Library read + verify -> transport head -> openSyncSession
  -> reviewed target -> stage content -> session.prepareLocal
  -> freshness check -> recorded local Sync + reconciliation
  -> upload -> remote CAS or verified read-back -> accept ancestry
```

Every non-clean applying path commits in this order:

1. Retain every copy the result references, downloading or reacquiring what is missing.
2. Recheck the reviewed local snapshot. Run the recorded local Sync, including retirement, state publication and reconciliation. Atomically publish the merged target with the actual remote head incorporated by that merge as its next merge base. When no remote head exists, do not invent one.
3. Upload snapshots the target references that the remote lacks.
4. Write the target by compare-and-swap on the remote revision read, unless the target already equals that head.
5. Verify the receipt, or read back the exact sent manifest after a failed response, before accepting its ancestry. Refuse acceptance if the local target or expected incorporated base changed.

A crash or CAS loss can therefore leave the target saved locally before it exists remotely. The next merge starts from the remote head already incorporated by that save, preserving later remote removals and enablement changes. A sent target is never itself proof of remote acceptance.

The device may instead persist a local global Binding selection. In that mode the
portable merge, account Bindings, and accepted base still use the account's
manifest; destination planning and projection use the device's selection. The
selection is stored in native Library rows alongside device custody and
is aligned when Skill or Collection identities are aligned. Individual Skill
entries remain individual, while Collection entries expand against the current
Collection membership. Existing state migrates to follow-account behavior.

For a device selection, an unmanaged duplicate, a destination collision, a
projection conflict, or a reconciliation failure after publication returns
`enablement_incomplete` and a nonzero command exit. The accepted Library and
ancestry remain committed, conflicting files are preserved, and a retry can use
the retained snapshots. The normal account-following behavior is unchanged.

Local publication precedes upload and remote CAS. A changed local snapshot stops publication with `SyncLocalChanged`; a failed transfer or write leaves the complete local result and its incorporated remote base available for retry. An already anchored clean sync skips remote writes and publishes only actual reconciliation changes.

Sync preserves undeclared local fields at every depth. Unknown top-level state fields, device facts and retained entity extensions survive push, pull, merge and clean anchoring. Such fields do not acquire a portable wire meaning merely by being retained: shared contracts still declare the fields the Registry understands. Released format and contract changes follow the coding standards' compatibility policy.

### Differences from the four earlier paths

The unification is not behaviour-identical. These differences are intended, and `packages/cli/test` pins each:

| Difference | Before | Now |
| --- | --- | --- |
| Undeclared local fields | Earlier schema rebuilding could drop them | Native publications preserve them, including clean anchoring |
| An edited copy whose Version a push changes | Published as `installed` with its old digest until reconciliation | Recorded locally as `conflicted` with its observed digest before upload/CAS |
| An applied clean of an anchored home | Published identical state twice | Publishes nothing and does not enter sync's retirement step |
| Reconciliation that changes nothing | Published identical state | Publishes nothing ([projection batches](#durable-state)) |
| A head in a newer manifest schema | `LibraryApiInvalidResponse` | `LibraryManifestTooNew` before any write ([Remote manifest version](#remote-manifest-version)) |
| Record order of a pushed manifest and the state it anchors | L's order | The merge's normalized order, as a merge already wrote |

## Durable state

| Store | Where | Written by | Atomicity |
| --- | --- | --- | --- |
| **Remote head** | D1 `libraries.current_revision_id` + `library_revisions` | `api.write` | Compare-and-swap batch on the expected revision |
| **Remote snapshots** | R2 + D1 `library_snapshots` | `api.upload` | Content-addressed; idempotent |
| **Originals** | `<home>/originals/<digest>` | `Library.content.stage` | Content-addressed; unreferenced trees are inert |
| **Local state** | Domain rows in `<home>/library.sqlite`, including the incorporated/accepted remote base | Library recorded Sync | One SQLite transaction, `synchronous = FULL` |
| **Projections** | Harness roots | Library recorded execution | Per-projection; derived from local state |

A projection batch whose state is unchanged, which wrote nothing and has no pending backup to settle, publishes nothing. A batch with backups to settle publishes onto the state it loaded first, so a backup is never judged against a state the Library has moved on from.

Local state and its incorporated remote base commit in one SQLite transaction. The later accepted receipt changes ancestry only after checking the expected local target and incorporated base. Restoring a complete Library database restores both sides together.

Notation: **L** is the local portable manifest, **R** the remote head, **B** the incorporated remote base stored with the local state. "Orphan" means a content-addressed object that nothing references; orphans are always legal.

## Preflight

Preflight writes nothing beyond the loader maintenance described under [Remote manifest version](#remote-manifest-version). Each row is checked in order; the first match returns.

| Condition | Outcome |
| --- | --- |
| A retained copy's bytes no longer hash to its digest | `local_bytes_changed` |
| R's manifest schema is newer than this CLI supports | `LibraryManifestTooNew` (see [Remote manifest version](#remote-manifest-version)) |
| B exists and (B.origin ≠ origin, or R is absent, or B.library_id ≠ R.library_id) | Continue with an empty base; report `merge_base: empty-different-library` |
| Neither L nor R exists | `clean` (nothing written) |

Missing or mismatched ancestry uses an empty base, so the merge can only add records. For two existing Libraries without ancestry the output reports `merge_base: empty-first-sync`; a changed Registry/Library reports `empty-different-library`. Preview remains read-only and `--apply` uses the ordinary push/merge path. There is no adoption flag or gate. Then exactly one of the paths below runs. Review, staging and network transfer do not hold a Library writer. Library owns the writer for local mutation. The prepared session checks a merge/pull snapshot before upload/CAS, and Library checks the reviewed revision again before its recorded local publication. If local state changed, publication is refused with `SyncLocalChanged`; sync never anchors an unrelated local state.

Every ready/apply path also checks enabled destinations using filesystem identity and previews affected projection custody before committing. A collision reports the Skill IDs and Collection labels. `--keep-enabled <skill-id>` keeps one competing Skill enabled and retains the others without enabling them; invalid or competing choices return `resolution_invalid`. Modified copies and repository Bindings that would lose their selected entities report device conflicts with specific remediation. These checks are read-only.

When one device follows a whole Collection while another disables a member, sync uses the syncing device's enabled choices for that Collection. Other Collections retain their three-way merged choices. The preview and applied plan report the affected Collections in `enabled_resolution` with `winner: "local"`; they do not offer `binding:global` as a `--take-remote` conflict. This changes enabled intent only: retained content, Collection/Skill records and device selections are preserved. Ordinary content conflicts and destination collisions still require their existing explicit resolutions.

Independent imports of the same upstream and tracking configuration adopt the published Collection identity; Skills match by source path within that Collection. New Skills independently discovered at the same path of an existing Collection also align. Matching names across different Sources never align identities. Equivalent Version handles then align as usual. Compatible histories and their Acquisition provenance are combined. Divergent independent observations whose remote selection follows the Source, or whose current membership differs, require a Collection conflict choice. Taking remote adopts its Collection observation graph and Version history, without pinning a Source Version as a local edit; strictly older local Acquisitions stay retained. Equal timestamps do not establish precedence. This choice is unavailable if local has a selected edit or any discarded Acquisition cannot be restored from a pinned Source revision. Rejected originals remain on disk. Ordinary updates to edited projections preserve the edited bytes and report the projection conflict during reconciliation; inactive edited copies also remain non-blocking while their references stay valid.

## Push — R absent, L present

The recorded local Sync publishes the reviewed target and reconciles copies before upload and `api.write(null, target)`. It retains an existing base if applicable; an absent remote is never recorded as a fabricated revision.

| Interruption | State left | Retry |
| --- | --- | --- |
| Before local publication | Prior local state; possibly unreferenced retained copies | Review again from the current local and remote state |
| After local publication, before upload/CAS | Complete local target; remote unchanged | Upload and push again, or merge if another home created the head |
| CAS loses | Local target retained | Read and merge the competing head; at most two automatic contention retries |
| Response lost | Local target retained; remote acceptance unknown | Exact read-back can prove acceptance; otherwise return the failure and retain retryable local state |
| After verified acceptance | Local target and accepted remote base | Unchanged retry is clean |

## Pull — R present, L absent

Retain the required copies, refuse a newly created local Library, then publish and reconcile the pulled target with B equal to the actual R read. If `--keep-enabled` changes the target, upload/CAS follows this local publication. A write failure retains that local result and B; a competing remote head is merged from B on retry. A plain pull whose target already equals R needs no remote write.

## Clean — L and R are equal after normalization

Preview writes nothing. Apply transfers, writes and retires nothing. It publishes only when the state's ancestry does not already name R: it then publishes the state with B = R, and if L changed after it was compared with R, the publish is refused with `SyncLocalChanged` and B is unchanged. This is how a home without ancestry anchors when it already matches the remote. An anchored home publishes nothing and sends no write request. Either way it then reconciles projections, which publishes only what it changes. Interruption between anchoring and reconciliation leaves stale projections, which the next `clean` repairs.

## First connection — L and R differ, no matching B

This is the normal merge path below, with an empty base. An empty base keeps records either side holds alone and reports records both sides hold with different contents as conflicts. It never infers a deletion.

A first push saves locally before attempting remote creation. If another home creates the Library first, retry uses the normal empty-base merge until an actual remote head has been incorporated. Compatible additions survive; genuine content conflicts remain explicit.

## Merge — L and R differ, matching B or an empty base

Records merge three-way by identity. Global Binding intent merges per Skill and per followed Collection, and a Binding entry for a record the merge removed is dropped: removing a Collection on one device wins over enabling its Skills on another, as it would if the removal had happened second.

A Collection removal concurrent with changes to its Skills or Acquisitions is one `collection:<id>` conflict. Taking remote chooses the remote Collection, its dependent records and its Binding contribution together, including remote deletion. Retained copies stay while another surviving Acquisition references them. Invalid merged records carry the Schema diagnostic naming the broken references; `manifest:invariants` is diagnostic-only and cannot be passed to `--take-remote`.

Resolution and conflict outcomes write nothing:

| Condition | Outcome |
| --- | --- |
| A `--take-remote` key is not a current conflict | `resolution_invalid` |
| Record, custody, or manifest-invariant conflicts remain | `conflicted` |
| Preview | `merge_ready` |

Apply retains required copies, checks freshness, and runs recorded retirement, local publication and reconciliation before upload/CAS. That local transaction stores the remote head R1 actually merged, rather than leaving the earlier base R0. Final ancestry acceptance requires a matching receipt or exact read-back of the sent target.

| Interruption | State left | Retry |
| --- | --- | --- |
| Before local publication | Old L and B, possibly retained unreferenced copies | Replan against the current head |
| During recorded local execution | Pending/stopped operation and durable progress | Existing owner recovery resumes or reports the recorded stop |
| After local publication, before CAS | Merged target with B = R1 | Upload/CAS against the head read, or merge a changed head from R1 |
| CAS loses to R2 | Local target with B = R1; R2 remains remote | Merge(R1, local target, R2), retaining R2's later removals and re-enablement |
| Lost response | Same local target/base; remote may have accepted | Exact read-back accepts it; unusable read-back leaves a failure and retryable state |
| After acceptance | Target with B equal to the proven receipt | Clean retry unless another edit occurred |

An intact installed copy whose selected Version changes retains custody evidence through local publication, then reconciliation updates it under marker/hash checks. Reidentified copies retire their old identities before that local publication. Pending missing copies remain pending during inventory scans and are recreated on retry; native-deletion suppression survives identity alignment.

## Safety invariants and their coverage

These are obligations of sync, not a claim that every existing test asserts all seven. The fault matrix captures each home, its projection root and their backups with the lossless `captureDisk` snapshot (`packages/cli/test/helpers/disk-snapshot.ts`) and asserts an empty diff where the row forbids local writes, or only orphan originals where the row permits them. Taking the writer lock creates a home that did not exist yet; the rows permit that directory itself, and the absent/empty matrix requires it to stay empty. The absence matrix also counts local publications and Registry write requests, which must stay unchanged on every no-op row, and captures file identity as complementary evidence; the counters, not identity, prove a write did or did not happen. The concurrent-local-write rows instead compare the new writer's exact state bytes and preserve existing projection bytes. Publication and recovery rows assert ancestry and retained records. The crash, custody, version-alignment, and merge-property suites cover the additional cases listed above; generated manifest merge properties do not constitute an exhaustive model of device synchronization.

1. **A CAS loser retains a retryable local result.** It cannot overwrite the winning remote head. Its persisted incorporated base distinguishes prior remote changes from new local intent.
2. **Only proven remote states become B.** Local publication may advance B to a head actually read even if a later transfer fails. A target sent to CAS becomes accepted ancestry only after a matching receipt or exact read-back.
3. **Conflicts are non-destructive.** A `conflicted` outcome leaves every store as it was.
4. **B records the remote contribution already incorporated into L.** Restoring a complete Library database restores its own B. Retrying from R1 after a local-first merge must not reinterpret R1 additions or disabled bindings as new local edits against R0.
5. **Ordinary mutations carry B unchanged.** A local removal after sync still syncs as a removal.
6. **Quiescent convergence.** When no home edits and every home syncs until `clean`, all homes hold the same normalized portable manifest, provided every snapshot or source is available, every schema is supported, and every conflict has been resolved.
7. **Device state stays local.** Invocation policies, harness roots, and custody records survive every merge (`blendRestoredState`).
