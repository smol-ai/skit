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
