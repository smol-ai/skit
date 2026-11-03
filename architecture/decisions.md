# Architecture decisions: draft for review

Each entry gives the problem, what I recommend, the corpus evidence, and whose call it is. **Revised** marks a recommendation the evidence changed. **No corpus evidence** means none was found, and the recommendation rests on SKIT's own code alone.

Pinned commits:
- maple `24ff600`
- t3code `3f94487`
- opencode `68bc26b`
- executor `4c753d3`
- yielded-auth `f1e2449`
- effect `3b28bf6`

```
M  = https://github.com/MapleTechLabs/maple/blob/24ff600da525eddfbe4f65bd4ca9da5e902e4c44
T  = https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1
O  = https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824
X  = https://github.com/UsefulSoftwareCo/executor/blob/4c753d3b1c4a5c4c9d926f718c02c0622635f2f6
E  = https://github.com/Effect-TS/effect/blob/3b28bf686bf26e9700edd39c025aff2744dc5303
```

## D1. One read reports both absence and revision

**Recommend:**
- `Library.read: Option<{ state, revision }>` replaces `load` and `inspect`, and the proposed `exists` is dropped.
- Writes succeed only if the revision is unchanged, and fail with a typed conflict otherwise.

**Evidence:**
- maple `loadCurrent` returns `{ document, version } | null` from one SELECT ([M/packages/backend/src/services/dashboards/DashboardPersistenceService.ts#L273-L296](https://github.com/MapleTechLabs/maple/blob/24ff600da525eddfbe4f65bd4ca9da5e902e4c44/packages/backend/src/services/dashboards/DashboardPersistenceService.ts#L273-L296)).
- maple `tryCasUpdate` writes only `WHERE version = expectedVersion`, and a failure becomes `DashboardConcurrencyError` (same file, L424-L511).
- No app in the corpus has a separate `exists`.

## D2. Migrations run once, when the Library layer is built (Revised)

**Problem:** today any `load` can migrate `state.json` under the lock (`packages/skit/src/library/store/state-file.ts:104-143`).

**Recommend:**
- `Library.layer` migrates once while it is being constructed, under the lock.
- After that, reads never write.
- Record-shape changes are upgraded as they are decoded and never rewritten.

**Evidence:**
- Every example migrates at layer construction, never on the next write. I found no example of "migrate on next write".
- Effect's own Migrator: "`layer` runs migrations during layer construction and provides no services" ([E/packages/sql/libsql/src/LibsqlMigrator.ts#L1-L13](https://github.com/Effect-TS/effect/blob/3b28bf686bf26e9700edd39c025aff2744dc5303/packages/sql/libsql/src/LibsqlMigrator.ts#L1-L13)).
- t3code `layerSetup` runs `runMigrations()` while building a layer that the CLI and server share ([T/apps/server/src/persistence/Sqlite.ts#L14-L41](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/apps/server/src/persistence/Sqlite.ts#L14-L41)). It refuses a database that another build wrote ([Migrations.ts#L186-L240](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/apps/server/src/persistence/Migrations.ts#L186-L240)).
- opencode migrates under a lock per file path: "Two instances over one file bootstrap the same schema" ([O/packages/core/src/database/database.ts#L33-L57](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/database/database.ts#L33-L57)).
- opencode upgrades old records as it decodes them: "payloads written in older shapes are upgraded in one place" ([O/packages/core/src/bus.ts#L74-L76](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/bus.ts#L74-L76)).
- Counter-example to avoid: t3code's settings file is rewritten on the first read, outside its write semaphore ([T/apps/server/src/serverSettings.ts#L764-L797](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/apps/server/src/serverSettings.ts#L764-L797)).

## D3. MachineSettings stays its own owner and stops borrowing the Library lock (Revised)

**Recommend:**
- A `DeviceSettings` owner for `machine.json`.
- The device identity is written once, by atomically linking a finished file into place and treating "already exists" as success, so it needs no lock.
- One home-directory lock is a shared platform function that every owner writing under `<home>` takes. That replaces `withConfigurationWriter` and each owner borrowing the Library's lock.

**Evidence:**
- t3code gives settings, identity, runtime state, secrets and the database separate paths and separate owners under one state directory ([T/apps/server/src/config.ts#L37-L56](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/apps/server/src/config.ts#L37-L56)).
- Its settings owner has its own write semaphore ([serverSettings.ts#L994-L1030](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/apps/server/src/serverSettings.ts#L994-L1030)).
- Its identity uses link-and-ignore-AlreadyExists: "Publish the completed file without replacing an ID created by another process" ([T/apps/server/src/environment/ServerEnvironment.ts#L84-L139](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/apps/server/src/environment/ServerEnvironment.ts#L84-L139)).
- It takes one exclusive lock for the whole directory, which the OS releases even on SIGKILL. That lock is a plain `Effect.fn`, not a service, and offline CLI writers take it too ([T/apps/server/src/serverOwnership.ts#L177-L240](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/apps/server/src/serverOwnership.ts#L177-L240), [cli/project.ts#L430-L434](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/apps/server/src/cli/project.ts#L430-L434)).
- Neither t3code nor opencode has one service writing both the domain state and the settings.

## D4. Undo, restore, accept-finding, inventory refresh and setup become Library intents

**Recommend:**
- These become intents that Library applies.
- Library writes the matching `removed/` journal entry and the audit entry in the same write step as the `state.json` change they describe.

**Evidence:**
- t3code's single event sink appends the event, applies the projection and queues side effects in one transaction ([T/apps/server/src/orchestration-v2/EventSink.ts#L243-L457](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/apps/server/src/orchestration-v2/EventSink.ts#L243-L457)): "Recorded before publication, so an interrupted publish cannot lose a committed outcome."
- t3code's rollback service gets that sink and no store writer ([runtimeLayer.ts#L188-L200](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/apps/server/src/orchestration-v2/runtimeLayer.ts#L188-L200)).
- opencode handles revert as an event whose projectors run inside the publish transaction ([O/packages/core/src/session/projector.ts#L760-L817](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/projector.ts#L760-L817), [bus.ts#L377-L441](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/bus.ts#L377-L441)).
- Your earlier sketch already planned `Undo | Restore | AcceptFinding` (`a8e9ca1de:experiments/refactor-api/owners.ts`).
- Gap: every example gets its atomicity from SQL. I found no file-based journal-plus-projection example.

**Decided (Tim, 2026-11-03): device state stays in files.**
- Each Library change is a single atomic `state.json` write that includes its operation record, so the journal and the state cannot diverge.
- Folder work runs after that write and is idempotent, keyed by derived installed-skill ids.
- On startup, for any operation recorded but not finished, Library finishes steps safe to repeat, otherwise stops and reports.
- `removed/` holds the moved-aside folders plus a note for each move, written before the move and never deleted (setup-recovery-refactor.md:26,43).
- **Stopped setup doesn't block (decided, Tim, 2026-11-03):** other Library changes stay allowed. Resume and undo recheck every folder and stop if anything changed. Corpus: t3code parks a failed step and carries on ([EffectOutbox.ts#L492-L519](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/apps/server/src/orchestration-v2/EffectOutbox.ts#L492-L519)); humanlayer parks one setup only ([setup.machine.ts#L45-L70](https://github.com/humanlayer/humanlayer/blob/0dbe4f58f0df9e337783defb2928e8ab18b88725/apps/riptide-daemon/src/effects/services/workspace-repository-setup/workspace-repository-setup.machine.ts#L45-L70)).
- **Undoing setup (decided, Tim, 2026-11-03):** undo also puts back the discovery folders setup saved in `machine.json`. It never touches the machine ID, the name or repository choices, which matches today (`setup-undo.ts:155-157,272-288`). The setup command calls both owners: Library for skills and folders, DeviceSettings for discovery folders. It is not a new service, and Library never writes `machine.json`.
- **Crash halfway (decided, Tim, 2026-11-03):** setup's steps are saved in `state.json` before any runs. The next run finishes steps that are safe to repeat. If anything differs from what was recorded, it stops and reports, and the user can undo. It never rolls back on its own.
  - humanlayer's workspace setup resumes from its saved step and parks on error ([setup.machine.ts#L45-L70](https://github.com/humanlayer/humanlayer/blob/0dbe4f58f0df9e337783defb2928e8ab18b88725/apps/riptide-daemon/src/effects/services/workspace-repository-setup/workspace-repository-setup.machine.ts#L45-L70)).
  - t3code re-runs only steps listed as safe to repeat and cancels the rest ([EffectOutbox.ts#L125-L144](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/apps/server/src/orchestration-v2/EffectOutbox.ts#L125-L144), [#L492-L519](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/apps/server/src/orchestration-v2/EffectOutbox.ts#L492-L519)).
  - Effect workflows replay after a crash and compensate only on failure ([Workflow.ts#L942-L961](https://github.com/Effect-TS/effect/blob/3b28bf686bf26e9700edd39c025aff2744dc5303/packages/effect/src/workflow/Workflow.ts#L942-L961)).

## Author owners

API: `architecture/author.ts`. Each entry is a choice today's code does not settle. Line refs are under `packages/cli/src`. **OPEN-FOR-TIM** marks a product choice waiting on Tim; the contract holds for every option.

**Settled (2026-11-03): no migration for author state.** No author command has been wired into `commands/tree.ts` since the first release, so no user holds author sync state. Old formats are rejected at the owner's loader with a clear error, with no back-compat (as for the old Draft protocol).

### A1. AuthorWorkspace is one service; every method takes the root

**Problem:** the owner could be built once per workspace folder, or once per process. Library remove marks a workspace at a path it finds in Library state (`library/author-workspace.ts:169-184`), and the history journal checks a copied id at another root (`workflows/author/history-journal.ts:48`), so one command touches more than one root.

**Recommend:** one `AuthorWorkspace` per process, no constructor config, `root` on every method. `AuthorWorkspace.root(input)` is the only way to make a `WorkspaceRoot`. It returns `realPath(resolve(input))` and fails `AuthorWorkspaceRootInvalid` unless that is a directory.

**Evidence:** t3code's `CheckpointStore` is one service whose methods take the folder: `readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;` ([T/apps/server/src/checkpointing/CheckpointStore.ts#L45-L75](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/apps/server/src/checkpointing/CheckpointStore.ts#L45-L75)).

### A2. Registration and connection: one transition each

**Problem:** `workspace.json` has its own lifecycle, separate from the connection (Unconnected, Connecting, Connected). They could share one `transition`, or each have its own.

**Recommend:** two methods, one per lifecycle: `register({ from, to })` and `transition({ from, to })`, both on the workspace lease (A8). Each takes the state it planned from and fails with `AuthorWorkspaceConflict`.
- `register` compares the on-disk identity with `from` by value, both id and registration, so it never replaces an id. `adopt` exists only on the case that starts from no identity.
- Registration states: `IdentityOnly` (the key is absent), `Registered`, `Removing` (A15) and `Removed`. Any identity can be backed up. Only `Registered` is registered for installation (ADR-0026:33-38).
- `Removed → Registered` needs an explicit `optIn`, as `register` does today (`workflows/author/workspace-identity.ts:26`). Nothing automatic resurrects a removed workspace.

**Evidence (partial):** t3code's outbox keeps one status union, and each transition is its own compare-and-set method that only applies from the expected status: `WHERE effect_id = ${effectId} AND status = 'running' … RETURNING effect_id` ([EffectOutbox.ts#L146-L152](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/apps/server/src/orchestration-v2/EffectOutbox.ts#L146-L152), [#L586-L637](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/apps/server/src/orchestration-v2/EffectOutbox.ts#L586-L637)). There, the expected state is fixed per method rather than passed in, and a conflict returns `false`. I found no example of two lifecycles on one entity.

### A3. Library checks that a folder is not already another collection

**Problem:** today `planAuthorWorkspace` reads Library state and refuses a folder that is already a different collection (`library/author-workspace.ts:46-105`), all under `withLibraryWriter`. Without that writer, a check made outside Library can race. `Library.import.authored` does not check it today.

**Recommend:**
- `Library.import.authored` refuses, under its own writer, a root or workspace id that another collection already claims.
- `AuthorWorkspace` does not require Library. When `workspace.json` is missing, the `author init` and `author sync` workflows find an id to reuse with `Library.read` and pass it as `adopt`.
- A partial result is reported as it is. If Library refuses the import after `register` succeeded, the workspace stays `Registered` and the command reports "registered, not imported" with Library's reason. A retry reuses the same identity.

**Evidence:** maple checks its precondition inside the write itself: `$.version.eq(expectedVersion),` ([M/packages/backend/src/services/dashboards/DashboardPersistenceService.ts#L424-L444](https://github.com/MapleTechLabs/maple/blob/24ff600da525eddfbe4f65bd4ca9da5e902e4c44/packages/backend/src/services/dashboards/DashboardPersistenceService.ts#L424-L444)).

### A4. A leftover checkpoint after connecting

**Problem:** a crash between writing `skit.remote.json` and deleting `.skit/connection.json` (`workflows/author/sync.ts:632-633`) leaves both files. Today the leftover file is ignored forever (`sync.ts:254-255`). If someone later deletes `skit.remote.json`, the next sync silently replays the old create. The leftover may also name a different remote than the one now connected.

**Recommend:**
- `read` reports `Connected { leftover: None | Matching | Mismatched | Invalid }`. The portable `skit.remote.json` is the authority (ADR-0010:13, ADR-0011:5).
- Sync deletes only a `Matching` leftover, through its own transition. That transition touches nothing but `connection.json` and never resets the sync checkpoint. `Mismatched` or `Invalid` stops sync, which reports it and changes nothing. Publish ignores the leftover.
- `Connecting → Connected` requires a `CreateReceipt` whose request id and destination match the checkpoint (`sync.ts:615-629`). Only that receipt may reset the checkpoint to `Idle { base: null }` (`syncState.transition` with `reset`).

**Evidence:** after a crash, t3code re-runs only the steps on its `REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS` list (`"checkpoint.capture"`, the cleanups) ([T/apps/server/src/orchestration-v2/EffectOutbox.ts#L125-L144](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/apps/server/src/orchestration-v2/EffectOutbox.ts#L125-L144)). This is the same rule as D4.

### A5. Whose sync checkpoint it is (decided)

**Problem:** the checkpoint is keyed only by the SKIT's locator (`sync.ts:93-96`). Two clones of one repository on one device therefore share a single `Idle | Sending | Writing` state. Sync can then plan one clone from the other's base, and a removal check measured against the wrong base can block, or allow, the wrong deletions.

**Decided:**
- The key is `{ workspaceId, locator }`, stored as `skit.sync-bindings.v4` (`workspaces → locator → state`).
- A v3 file, which is locator-only, fails `AuthorSyncStateInvalid` at the loader. So do v2 and pre-release files. There is no migration (see "Settled" above).
- `author sync --apply` creates an identity when there is none, as `IdentityOnly` (ADR-0026:24-27, :36-38), adopting a Library id as in A3. It never changes an existing registration, so a `Removed` workspace is backed up but never promoted.

**Evidence:** opencode gives clones a shared project id but keys local state by project plus checkout: `path.join(global.data, "snapshot", location.project.id, Hash.fast(worktree))` ([snapshot.ts#L92-L103](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/snapshot.ts#L92-L103)). The worktree table's key is `(project_id, directory)` ([worktree/sql.ts#L7-L21](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/worktree/sql.ts#L7-L21)), and the code notes "Clones share a project ID" ([project.ts#L137-L149](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/project.ts#L137-L149)).

### A6. Concurrent syncs overwrite each other's checkpoints

**Problem:** `saveSyncState` reads the whole `sync-bindings.json`, changes one entry and renames the file over the old one (`sync.ts:339-374`). Nothing holds a lock. Two SKITs syncing at once can each erase the other's checkpoint, and a lost `Sending` or `Writing` checkpoint is exactly what recovery needs.

**Recommend:** `syncState.transition` holds the home lock (D3) for the whole read-modify-write.
- It refuses with `AuthorSyncStateConflict` unless the saved entry still equals `from`.
- It rewrites only that entry and keeps every other entry.
- It refuses `AuthorSyncStateIllegal` unless the engine's pure step policy allows `from → to`.
- Busy surfaces as `HomeBusy`.

**Evidence:** t3code's whole-directory lock: "Hold an exclusive lock on the state directory until the scope closes" ([T/apps/server/src/serverOwnership.ts#L177-L197](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/apps/server/src/serverOwnership.ts#L177-L197)). For the check against `from`, see maple's `$.version.eq(expectedVersion)` (A3).

### A7. AuthorHistory provides storage; the sync command runs the engine (decided)

**Problem:** `app.ts` gave AuthorHistory a `sync(remote)` operation. A `withStore` escape hatch would instead give any caller raw store authority (core `history.ts:95-105`). `Sync.Remote` is a `Context.Service` (core `sync.ts:95-124`), yet it owns no state, holds no resource, and is built anew for every command (`sync.ts:517-590`).

**Decided:**
- AuthorHistory exposes owner methods (`observe`, `retain`, `syncState.{read, transition}`) and one narrow `engineStore`, a `History.Store` adapter it builds over `<home>/history`. **Approved storage port:** the engine may write through that adapter because its writes (`putTree`, `commit`) are immutable, content-addressed and idempotent (`device-store.ts:32-66`). The adapter never touches the journal or `sync-bindings.json`.
- `Sync.Remote` becomes a plain `remote` input to `Sync.loadPlanInput` and `Sync.run`, built by the workflow from the Registry client. This follows the service rule, which allows a service only when it owns state or holds a resource. Listed in `app.ts` removals.
- The workflow drives `Sync.run`. Its `write` callback calls `observe` and then `lease.writeTree`. AuthorHistory needs neither the Registry nor AuthorWorkspace's write side.

**Evidence (partial):** t3code's stores expose narrow writes, for example `/** Call inside the commit transaction. */ readonly apply` ([ProjectStore.ts#L73-L77](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/apps/server/src/orchestration-v2/ProjectStore.ts#L73-L77)). A separate driver composes them into one commit ([EventSink.ts#L739-L766](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/apps/server/src/orchestration-v2/EventSink.ts#L739-L766)). In t3code that driver is a service, while here the rules make it a plain function.

### A8. One writer at a time per workspace: the lease (decided)

**Problem:** ADR-0026:228-236 requires an exclusive lock per workspace, held across processes and across network waits, and released during retry sleeps. Nothing implements it today. Two `author sync --apply` runs on one folder can interleave their checkpoints and file writes.

**Decided:**
- `AuthorWorkspace.acquire(root)` returns a scoped `WorkspaceLease`. All workspace writes are methods on the lease: `register`, `transition` and `writeTree`. The plain built-in edits (`init` scaffold, `invocation`) take the lease as evidence, and `register`, remove and sync all hold it.
- The lease is not reentrant: a second acquire fails `AuthorWorkspaceBusy` at once, in this process or another.
- The lock file is `.skit/lock`. Before taking it, acquire checks that `realPath(root) === root`, refuses a `.skit` that is not a real directory, and opens the lock with no-follow, refusing anything but a regular file (`AuthorWorkspaceUnsafe`). The OS releases the lock on crash.
- Previews and reads never acquire it, so they never create `.skit` or the lock.
- `lease.releasedFor(sleep)` releases the lease during network retry sleeps and then takes it back. Every later transition re-checks `from`.
- Lock order: workspace lease, then the short home-lock writes, then the Library writer. Only the lease spans network calls.

**Evidence:** t3code's lock: "the OS releases it when the process exits, even on SIGKILL, so a crashed owner never blocks the next start" ([T/apps/server/src/serverOwnership.ts#L177-L197](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/apps/server/src/serverOwnership.ts#L177-L197)).

### A9. The journal's writer permit belongs to the layer

**Problem:** the journal's writer semaphore is a module-level global (`workflows/author/history-journal.ts:29`), so every runtime in the process shares it. It exists because node:sqlite busy waits block the JS thread (`history-journal.ts:26-28`).

**Recommend:**
- `AuthorHistory.layer` creates the permit.
- The app builds one layer per home and shares it, so each home has exactly one permit in a process. Two layers over one home in one process would each hold their own permit, and could block the thread again.
- SQLite's `BEGIN IMMEDIATE` and the busy retries still coordinate between processes.

**Evidence:** opencode: "The bootstrap lock is scoped to the database being built, never to this module" ([O/packages/core/src/database/database.ts#L28-L33](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/database/database.ts#L28-L33)).

### A10. AuthorHistory reads workspace identity through a narrow read (decided)

**Problem:** history reads `workspace.json` directly, both for this root and for an older root when it checks for a live copy (`workflows/author/history.ts:117`, `history-journal.ts:48`), with a path-provenance fallback (`history.ts:115-119`). The full `read` also decodes the connection files and can fail `AuthorRemoteMetadataInvalid` or `AuthorSyncStateInvalid`, which would block backup.

**Decided:**
- AuthorHistory requires AuthorWorkspace and uses only `identity(root)`, which reads `workspace.json` alone.
- Only `AuthorWorkspaceMetadataInvalid` falls back to path provenance. An absent file, or a gone root, is `None`. Other failures propagate, so "no identity" is never confused with "could not read".
- AuthorWorkspace never requires AuthorHistory, so there is no cycle.

**Evidence:** t3code's `WorkspaceFileSystem` is built on the owners it reads from: `Layer.provide(WorkspacePaths.layer), Layer.provide(layerWorkspaceEntries), Layer.provide(layerKnownWorkspaces)` ([T/apps/server/src/server.ts#L454-L458](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/apps/server/src/server.ts#L454-L458)).

### A11. Writes the author asks for stay outside AuthorWorkspace

**Problem:** `author init` scaffolds `skit.json` (`library/author-workspace.ts:163`), and `author invocation` writes skill metadata into the workspace (`handlers/author/invocation.ts:17`). These write authored content, not owner state.

**Recommend:**
- They stay plain functions, like an editor's save, but they run under the workspace lease, so a built-in edit can never race a sync. AuthorWorkspace owns only the writes sync makes.
- An external editor cannot take the lease. `writeTree` re-checks each target just before it changes it (`local-tree.ts:145-172`), but that check is not atomic against another writer. An editor save that lands between the check and the rename can be overwritten. This is a known limitation, not something the contract prevents. The edit is in history only if an observation saw it.

**Evidence (indirect):** neither opencode nor t3code routes user edits through the service that tracks the tree. They observe the tree afterwards: opencode "Capture the current … filesystem state as a content-addressed tree" ([snapshot.ts#L43-L67](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/snapshot.ts#L43-L67)), and t3code "all changed paths then belong to the turn" ([CheckpointStore.ts#L66-L69](https://github.com/pingdotgg/t3code/blob/3f9448747bb8848050dc2cacf83affa6f94a66a1/apps/server/src/checkpointing/CheckpointStore.ts#L66-L69)). I found no example of an owner refusing a write because the tree drifted.

### A12. An interrupted write that finds local edits (decided: merge)

**Problem:** D4's rule says to finish recorded safe steps and otherwise stop and report. Today's engine does something else. On a `Writing` checkpoint whose files changed, it records the edits as a revision on the base, posts it, merges it with the pending target, and writes the merged tree (core `sync.ts:484-517`). That merged write has no checkpoint naming it (`sync.ts:516-517`).

**Holds for both options:**
- Every workspace write is preceded by a durable `Writing` naming exactly its `from` and `to`, which `writeTree` enforces through `PreparedWrite` (A13).
- The checkpoint advances past `Writing` only after `writeTree` returns.
- Replanning after a lost Registry compare-and-set (`Sync.Moved`, `sync.ts:460-464`) is separate and unchanged.

**Options:**
- **resume:** each path whose file matches the checkpoint's `from` or `to` entry is finished to `to`. If any path matches neither, sync stops and reports those paths. It keeps the `Writing` checkpoint and leaves the edited files alone, which `observe` has already backed up. This needs an explicit way forward for the user.
- **merge (today):** as described above, plus a new `Writing` saved for the merged tree before it is written.

**Decided (Tim, 2026-11-04): merge.** The next sync carries on like a normal sync: it keeps your edits, finishes the server's changes, and reports a file you both changed as a conflict instead of overwriting it. This is an exception to D4's stop-and-report rule. D4 is about Library setup steps, where stopping is safe; here, stopping would only make the user do a merge by hand that sync can already do safely.

### A13. writeTree is linked to a durable checkpoint and is durable itself (decided)

**Problem:** `writeTree` took bare trees (`author.ts`, earlier draft), so nothing proved a `Writing` checkpoint existed. Today it stages in the global temp dir (`sync.ts:417`) and renames across (`:427`), which is EXDEV on another filesystem. It also never fsyncs (`sync.ts:421-434`), while the engine advances the checkpoint right after (core `sync.ts:569-572`).

**Decided:**
- `syncState.transition` returns a `PreparedWrite` when it saves a `Writing`, after checking that both trees are stored. `lease.writeTree` requires one and refuses `AuthorWriteNotPrepared` unless the trees hash to it.
- `writeTree` stages under `<root>/.skit/stage-*`, on the target filesystem. EXDEV from a nested mount is reported, never copied around.
- Before success, `writeTree` fsyncs every written file and every directory whose entries changed. The next acquire removes leftover stage folders.

### A14. Sync's scan must be the tree it observed (decided; one item OPEN)

**Problem:** `Observation` dropped `treeHash`, and sync scans a second time (`sync.ts:511`) while using the first observation's timestamp as its edit time (`sync.ts:670`).

**Decided:** `observe` returns `treeHash`, and `scanAuthorSyncTree` reports the verbatim hash of the snapshot it normalized. If the two differ, sync observes and scans again, a bounded number of times, and then fails `LocalFilesChangedDuringSync`.

**OPEN (sync policy, not blocking):** a timestamp per path and how clock skew is reported (`docs/author-sync-port.md`, "Next slices" 1).

### A15. Removing an authored collection survives a crash between owners (decided)

**Problem:** `library remove` runs `Library.apply`, then marks the workspace removed (`workflows/library/remove.ts:81`). A crash between the two leaves a workspace that still says `Registered` for a collection that is gone.

**Decided:** there is no coordinator service.
1. Under the workspace lease, `register { → Removing }` records the intent durably.
2. `Library.apply(Remove)` runs.
3. `register { Removing → Removed }` completes the removal.

A retry that finds `Removing` runs `Library.apply` again only if the collection is still there, then marks the workspace `Removed`. `Removing` already counts as opted out for promotion. The workspace is marked only if it still carries the collection's id (`author-workspace.ts:169-184`). If the root is gone, `Library.apply` runs alone.

### A16. Delete leaves the local binding stale (decided)

**Problem:** `author delete` touches only the Registry. The earlier draft claimed the next first connection resets the stale checkpoint, which is not automatically true: a Connected workspace never reconnects by itself.

**Decided (Tim, 2026-11-04):** delete leaves `skit.remote.json`, the checkpoint and the history as they are. The next sync of that workspace reports `remote_missing` and stops. Reconnecting is an explicit user action, such as removing `skit.remote.json` and syncing with `--to`. Its first connection then resets the checkpoint through a `CreateReceipt` (A4). Nothing resets on its own, because a missing remote may be an outage or a permissions problem rather than a deletion.
