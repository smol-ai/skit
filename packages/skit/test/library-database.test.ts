import { inspectLocalLibraryState } from "../src/library/store/state-file.js";
import { prepareSetupChanges } from "../src/library/store/setup-intent.js";
import {
  withDatabaseTransaction,
  migrateLibraryDatabase,
  prepareLibraryDatabase,
} from "../src/library/store/database.js";
import { prepareLibraryDifference } from "../src/library/store/difference.js";
import { canonicalJson } from "../src/shared/json.js";
import { fixture as valuesFixture } from "./helpers/library-values.js";
import { snapshotOf, Revision } from "../src/library/snapshot.js";
import {
  loadOperations,
  loadOperationHistory,
  loadLibrary,
  LibraryWriter,
  writeLibrary,
} from "../src/library/store/library-store.js";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { systemError } from "effect/PlatformError";
import { Migrator, SqlClient } from "effect/sql";
import { join } from "node:path";
import { libraryDatabasePath, withLibraryDatabase } from "../src/library/store/database.js";
import { migrateLocalLibraryState, readDatabaseState } from "../src/library/store/state-file.js";
import {
  decodeLibraryState,
  emptyLibraryState,
  libraryManifestFromLocalState,
  libraryStateRevision,
} from "../src/library/library-state.js";

import { LibraryAuditEvent, readLibraryAudit } from "../src/library/audit/audit-log.js";
import { makeOperationId } from "../src/library/entity-ids.js";
import { setupIntent, recordedLibrary } from "../src/library/store/intent.js";
import { OperationStatus } from "../src/library/store/state-schema.js";

import { writeRawAtomic } from "../src/platform/atomic-write.js";
import { skitLayer } from "../src/platform/layer.js";

const legacy = {
  schemaVersion: 9,
  unmanaged: [
    { harness: "codex", path: "/skills/review", observedHash: `sha256:${"a".repeat(64)}` },
  ],
  collections: [],
  skills: [],
  retained_copies: [],
  acquisitions: [],
  global_bindings: [],
  local_bindings: [],
  projections: [],
};

it.effect(
  "imports released v9 state and ordered audit events once, retaining originals and fencing 0.3.0",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-database-import-" });
      const statePath = join(home, "state.json");
      const auditPath = join(home, "audit.jsonl");
      const events = yield* Effect.forEach(
        ["2026-11-05T00:00:00.000Z", "2026-11-04T00:00:00.000Z"],
        (occurredAt) =>
          LibraryAuditEvent.makeEffect({
            schemaVersion: 1,
            eventId: makeOperationId(),
            occurredAt,
            type: "library.imported",
            workflow: "test",
            changes: [],
          }),
      );
      const original = JSON.stringify(legacy);
      const audit = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
      yield* fs.writeFileString(statePath, original);
      yield* fs.writeFileString(auditPath, audit);
      yield* migrateLocalLibraryState(home);
      const state = yield* loadLibrary(home);
      const expected = yield* decodeLibraryState({
        ...emptyLibraryState(),
        unmanaged: [
          {
            harness: "codex",
            path: legacy.unmanaged[0]!.path,
            currentHash: legacy.unmanaged[0]!.observedHash,
          },
        ],
      });
      assert.strictEqual(canonicalJson(state), canonicalJson(expected));
      assert.strictEqual(libraryStateRevision(state), libraryStateRevision(expected));
      assert.strictEqual(state.unmanaged[0]?.currentHash, legacy.unmanaged[0]?.observedHash);
      assert.deepStrictEqual(yield* loadOperations(home), []);
      assert.deepStrictEqual(yield* readLibraryAudit(home), events);
      assert.strictEqual(
        yield* fs.readFileString(join(home, "state.json.v9.backup-database")),
        original,
      );
      assert.strictEqual(yield* fs.readFileString(auditPath), audit);
      const stub = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ schemaVersion: Schema.Finite })),
      )(yield* fs.readFileString(statePath));
      // This is the released reader's refusal condition, before it attempts to decode a v9 Library.
      assert.isAbove(stub.schemaVersion, 9);
      yield* fs.writeFileString(auditPath, "invalid legacy content after completed import");
      const failure = yield* Effect.flip(migrateLocalLibraryState(home));
      assert.strictEqual(failure._tag, "InvalidLibraryState");
      if (failure._tag === "InvalidLibraryState")
        assert.strictEqual(failure.reason._tag, "LegacySourceChanged");
      assert.deepStrictEqual(yield* loadLibrary(home), state);
      yield* fs.writeFileString(auditPath, audit);
      assert.deepStrictEqual(yield* readLibraryAudit(home), events);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("preserves extensions in audit rows and refuses conflicting event identities", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const event = {
      schemaVersion: 1,
      eventId: makeOperationId(),
      occurredAt: "2026-11-05T00:00:00.000Z",
      type: "library.imported",
      workflow: "test",
      extra: { unread: true },
      changes: [{ entity: "library", id: "library", action: "imported", detail: ["keep"] }],
    };
    for (const conflict of [false, true]) {
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-audit-extensions-" });
      const events = conflict ? [event, { ...event, extra: { unread: false } }] : [event];
      yield* fs.writeFileString(
        join(home, "audit.jsonl"),
        events.map((value) => JSON.stringify(value)).join("\n") + "\n",
      );
      if (conflict) {
        const failure = yield* Effect.flip(migrateLocalLibraryState(home));
        assert.strictEqual(failure._tag, "LibraryAuditInvalid");
        if (failure._tag === "LibraryAuditInvalid")
          assert.strictEqual(failure.reason._tag, "EventIdentityChanged");
      } else yield* migrateLocalLibraryState(home);
      const rows = yield* withLibraryDatabase(
        libraryDatabasePath(home),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ document: string }>`SELECT document FROM library_audit_events`;
        }),
        true,
      );
      assert.deepStrictEqual(
        rows.map((row) => row.document),
        conflict ? [] : [canonicalJson(event)],
      );
    }
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const boundary of ["before-publication", "before-stub"])
  it.effect(`retries import after failure ${boundary} without changing the released files`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-database-import-failure-" });
      const statePath = join(home, "state.json");
      const path = libraryDatabasePath(home);
      const original = JSON.stringify(legacy);
      yield* fs.writeFileString(statePath, original);
      const files: FileSystem.FileSystem = {
        ...fs,
        link: (from, to) =>
          boundary === "before-publication" && to === path
            ? Effect.fail(
                systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "link",
                  pathOrDescriptor: to,
                }),
              )
            : fs.link(from, to),
        rename: (from, to) =>
          boundary === "before-stub" && to === statePath
            ? Effect.fail(
                systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                  pathOrDescriptor: to,
                }),
              )
            : fs.rename(from, to),
      };
      const failure = yield* Effect.flip(
        migrateLocalLibraryState(home).pipe(Effect.provideService(FileSystem.FileSystem, files)),
      );
      assert.strictEqual(failure._tag, "PlatformError");
      assert.strictEqual(yield* fs.readFileString(statePath), original);
      assert.strictEqual(yield* fs.exists(path), boundary === "before-stub");
      assert.strictEqual(yield* fs.exists(join(home, ".lock")), boundary === "before-stub");
      yield* migrateLocalLibraryState(home);
      assert.isFalse(yield* fs.exists(join(home, ".lock")));
      assert.strictEqual(
        (yield* loadLibrary(home)).unmanaged[0]?.currentHash,
        legacy.unmanaged[0]?.observedHash,
      );
      assert.strictEqual(
        yield* fs.readFileString(join(home, "state.json.v9.backup-database")),
        original,
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("stops when a released writer changes state in the publication-to-stub gap", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-database-import-diverged-" });
    const statePath = join(home, "state.json");
    yield* fs.writeFileString(statePath, JSON.stringify(legacy));
    const files: FileSystem.FileSystem = {
      ...fs,
      rename: (from, to) =>
        to === statePath
          ? Effect.fail(
              systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "rename" }),
            )
          : fs.rename(from, to),
    };
    yield* Effect.flip(
      migrateLocalLibraryState(home).pipe(Effect.provideService(FileSystem.FileSystem, files)),
    );
    const before = yield* loadLibrary(home);
    const edited = JSON.stringify({ ...legacy, unmanaged: [] });
    yield* fs.writeFileString(statePath, edited);
    const error = yield* Effect.flip(migrateLocalLibraryState(home));
    assert.strictEqual(error._tag, "InvalidLibraryState");
    if (error._tag === "InvalidLibraryState")
      assert.deepStrictEqual(error.reason, {
        _tag: "LegacySourceChanged",
        sourcePath: statePath,
        backupPath: join(home, "state.json.v9.backup-database"),
        databasePath: libraryDatabasePath(home),
      });
    assert.strictEqual(yield* fs.readFileString(statePath), edited);
    assert.deepStrictEqual(yield* loadLibrary(home), before);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("never replaces a database published by another writer during import", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-database-import-existing-" });
    const path = libraryDatabasePath(home);
    const original = JSON.stringify(legacy);
    yield* fs.writeFileString(join(home, "state.json"), original);
    const files: FileSystem.FileSystem = {
      ...fs,
      link: (from, to) =>
        Effect.gen(function* () {
          if (to === path)
            yield* fs.writeFileString(path, "another writer's target", { flag: "wx" });
          return yield* fs.link(from, to);
        }),
    };
    yield* Effect.flip(
      migrateLocalLibraryState(home).pipe(Effect.provideService(FileSystem.FileSystem, files)),
    );
    assert.strictEqual(yield* fs.readFileString(path), "another writer's target");
    assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), original);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "keeps ancestry in the state document and rolls back document, operations and drafts together",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-database-transaction-" });
      const state = emptyLibraryState();
      const ancestry = {
        origin: "https://registry.example",
        library_id: "library",
        revision_id: "revision",
        base_manifest: yield* libraryManifestFromLocalState(state),
      };
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          yield* writer.save({ ...state, sync_ancestry: ancestry }, state);
        }),
      );
      const before = yield* loadLibrary(home);
      const pending = OperationStatus.cases.Pending.make({
        operationId: makeOperationId(),
        steps: [],
        before: recordedLibrary(before),
      });
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          yield* (yield* LibraryWriter).recordOperation(
            pending,
            snapshotOf(yield* inspectLocalLibraryState(home)),
            "apply",
          );
        }),
      );
      const events = yield* readLibraryAudit(home);
      const path = libraryDatabasePath(home);
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const { state: document } = yield* readDatabaseState(path);
          assert.deepStrictEqual(document?.sync_ancestry, ancestry);
          assert.isFalse(Object.hasOwn(document ?? {}, "operations"));
          yield* sql`CREATE TRIGGER operation_failure BEFORE UPDATE ON library_operations BEGIN SELECT RAISE(ABORT, 'operation unavailable'); END`;
        }),
      );
      const failed = yield* Effect.flip(
        writeLibrary(
          home,
          Effect.gen(function* () {
            const writer = yield* LibraryWriter;
            yield* writer.saveOperation(
              { ...pending, preparation: { roots: [], done: true } },
              pending,
              {
                next: {
                  ...before,
                  scanIssues: [{ path: "/missing", harness: "codex", code: "MISSING_ROOT" }],
                },
                base: before,
              },
            );
          }),
        ),
      );
      assert.strictEqual(failed._tag, "LibrarySqlError");
      assert.deepStrictEqual(yield* loadLibrary(home), before);
      assert.deepStrictEqual(yield* readLibraryAudit(home), events);
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.strictEqual(
            (yield* sql`SELECT * FROM library_audit_events`).length,
            events.length + 1,
          );
          assert.deepStrictEqual(yield* loadOperations(home), [pending]);
          yield* sql`DROP TRIGGER operation_failure`;
        }),
      );
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          yield* writer.save(
            {
              ...before,
              scanIssues: [{ path: "/missing", harness: "codex", code: "MISSING_ROOT" }],
            },
            before,
          );
          const error = yield* Effect.flip(writer.save(before, before));
          assert.strictEqual(error._tag, "LibraryChanged");
        }),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "keeps completed source history separate from live recovery evidence, drafts and current fields",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({
        prefix: "skit-database-development-import-",
      });
      const current = emptyLibraryState();
      const before = recordedLibrary(current);
      const operations = yield* Schema.encodeEffect(Schema.Array(OperationStatus))([
        OperationStatus.cases.Done.make({
          operationId: makeOperationId(),
          steps: [],
          before,
          after: before,
        }),
        OperationStatus.cases.Pending.make({ operationId: makeOperationId(), steps: [], before }),
        OperationStatus.cases.Stopped.make({
          operationId: makeOperationId(),
          steps: [],
          before,
          after: before,
          reason: { _tag: "LibraryChanged", step: 0, revision: Revision.make("changed") },
        }),
      ]);
      const event = yield* LibraryAuditEvent.makeEffect({
        schemaVersion: 1,
        eventId: makeOperationId(),
        occurredAt: "2026-11-05T00:00:00.000Z",
        type: "library.imported",
        workflow: "test",
        changes: [{ entity: "library", id: "imported-recovery", action: "operation-Pending" }],
      });
      const historyDelivery = {
        schemaVersion: 1,
        pending: [{ event, operationIds: [operations[1]!.operationId] }],
      };
      const original = JSON.stringify({
        ...current,
        extension: { keep: true },
        operations,
        historyDelivery,
      });
      yield* fs.writeFileString(join(home, "state.json"), original);
      yield* migrateLocalLibraryState(home);
      const expected = { ...current, extension: { keep: true } };
      assert.deepStrictEqual(yield* loadLibrary(home), expected);
      const imported = yield* loadOperations(home);
      assert.deepStrictEqual(
        (yield* loadOperationHistory(home)).map((row) => row.operationId),
        operations.map((row) => row.operationId),
      );
      assert.deepStrictEqual(
        imported.map((row) => row.operationId),
        operations.slice(1).map((row) => row.operationId),
      );
      assert.deepStrictEqual(
        imported.map((row) => row._tag),
        ["Pending", "Stopped"],
      );
      for (const row of imported) {
        assert.deepStrictEqual(row.before, { installedSkills: [] });
        assert.deepStrictEqual(
          row.setup?.changes,
          yield* prepareSetupChanges(setupIntent(current), setupIntent(current), home),
        );
        assert.deepStrictEqual(row.steps, []);
      }
      yield* withLibraryDatabase(
        libraryDatabasePath(home),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const drafts = yield* sql<{
            document: string;
            operation_ids: string;
          }>`SELECT document, operation_ids FROM library_audit_events`;
          assert.deepStrictEqual(
            drafts.map((row) => ({
              event: JSON.parse(row.document),
              operationIds: JSON.parse(row.operation_ids),
            })),
            historyDelivery.pending,
          );
        }),
        true,
      );
      assert.deepStrictEqual(yield* readLibraryAudit(home), []);
      const pending = (yield* loadOperations(home)).find((record) => record._tag === "Pending");
      if (pending?._tag !== "Pending") return assert.fail("Missing imported operation");
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          yield* (yield* LibraryWriter).settleOperation(pending);
        }),
        { resume: pending.operationId },
      );
      const delivered = (yield* readLibraryAudit(home)).filter(
        (record) => record.eventId === event.eventId,
      );
      assert.strictEqual(delivered.length, 1);
      assert.strictEqual(delivered[0]?.workflow, event.workflow);
      assert.deepStrictEqual(delivered[0]?.changes, [
        ...event.changes,
        { entity: "library", id: pending.operationId, action: "operation-Done" },
      ]);
      assert.strictEqual(
        yield* fs.readFileString(
          join(home, `state.json.v${current.schemaVersion}.backup-database`),
        ),
        original,
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a completed database remains authoritative when only its old-CLI stub is missing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-database-restored-" });
    yield* fs.writeFileString(join(home, "state.json"), JSON.stringify(legacy));
    yield* migrateLocalLibraryState(home);
    const before = yield* loadLibrary(home);
    yield* fs.remove(join(home, "state.json"));
    yield* migrateLocalLibraryState(home);
    assert.deepStrictEqual(yield* loadLibrary(home), before);
    const stub = yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Struct({ schemaVersion: Schema.Finite })),
    )(yield* fs.readFileString(join(home, "state.json")));
    assert.isAbove(stub.schemaVersion, 9);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "concurrent readers see the state document and operation rows from one SQL snapshot",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-database-snapshot-" });
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const state = yield* loadLibrary(home);
          yield* (yield* LibraryWriter).save(state, state);
        }),
      );
      yield* Effect.all(
        [
          writeLibrary(
            home,
            Effect.gen(function* () {
              const writer = yield* LibraryWriter;
              for (let index = 0; index < 6; index++) {
                const state = yield* loadLibrary(home);
                const id = makeOperationId();
                const operation = OperationStatus.cases.Pending.make({
                  operationId: id,
                  steps: [],
                  before: { installedSkills: [] },
                  setup: {
                    changes: yield* prepareSetupChanges(
                      setupIntent(state),
                      setupIntent(state),
                      home,
                    ),
                  },
                });
                yield* writer.recordOperation(
                  operation,
                  snapshotOf(yield* inspectLocalLibraryState(home)),
                  "setup",
                );
                yield* writer.saveOperation(
                  { ...operation, preparation: { roots: [], done: true } },
                  operation,
                  {
                    next: {
                      ...state,
                      scanIssues: [{ path: id, harness: "codex", code: "MISSING_ROOT" }],
                    },
                    base: state,
                  },
                );
              }
            }),
          ),
          Effect.gen(function* () {
            for (let index = 0; index < 12; index++) {
              yield* withLibraryDatabase(
                libraryDatabasePath(home),
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  const observed = yield* sql.withTransaction(
                    Effect.gen(function* () {
                      const { state } = yield* readDatabaseState(libraryDatabasePath(home));
                      const operations = yield* sql<{
                        operation_id: string;
                      }>`SELECT operation_id FROM library_operations
                      WHERE json_extract(document, '$.preparation.done') = 1 ORDER BY position DESC LIMIT 1`;
                      return {
                        path: state?.scanIssues?.[0]?.path ?? null,
                        operation: operations[0]?.operation_id ?? null,
                      };
                    }),
                  );
                  assert.strictEqual(observed.path, observed.operation);
                }),
                true,
              );
            }
          }),
        ],
        { concurrency: "unbounded" },
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("refuses a released writer's lock without changing its owner or original state", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-database-released-lock-" });
    const original = JSON.stringify(legacy);
    const owner = "123@device released-owner\n";
    yield* fs.writeFileString(join(home, "state.json"), original);
    yield* fs.writeFileString(join(home, ".lock"), owner);
    const error = yield* Effect.flip(migrateLocalLibraryState(home));
    assert.strictEqual(error._tag, "HomeBusy");
    if (error._tag === "HomeBusy") assert.strictEqual(error.owner, owner);
    assert.strictEqual(yield* fs.readFileString(join(home, ".lock")), owner);
    assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), original);
    assert.isFalse(yield* fs.exists(libraryDatabasePath(home)));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("audit edits after publication stop fencing and name both source and database", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-import-audit-changed-" });
    const statePath = join(home, "state.json");
    const auditPath = join(home, "audit.jsonl");
    const original = JSON.stringify(legacy);
    yield* fs.writeFileString(statePath, original);
    yield* fs.writeFileString(auditPath, "");
    yield* Effect.flip(
      migrateLocalLibraryState(home).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) =>
            to === statePath
              ? Effect.fail(
                  systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "rename" }),
                )
              : fs.rename(from, to),
        }),
      ),
    );
    const appended = "released writer appended after publication\n";
    yield* fs.writeFileString(auditPath, appended);
    const error = yield* Effect.flip(migrateLocalLibraryState(home));
    assert.strictEqual(error._tag, "InvalidLibraryState");
    if (error._tag === "InvalidLibraryState")
      assert.deepStrictEqual(error.reason, {
        _tag: "LegacySourceChanged",
        sourcePath: auditPath,
        backupPath: join(home, "audit.jsonl.backup-database"),
        databasePath: libraryDatabasePath(home),
      });
    assert.strictEqual(yield* fs.readFileString(statePath), original);
    assert.strictEqual(yield* fs.readFileString(auditPath), appended);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("unchanged source digests finish fencing independently of backup contents", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-import-digest-" });
    const statePath = join(home, "state.json");
    yield* fs.writeFileString(statePath, JSON.stringify(legacy));
    let refused = false;
    yield* Effect.flip(
      migrateLocalLibraryState(home).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) =>
            Effect.gen(function* () {
              if (to === statePath) {
                const result = yield* Effect.result(
                  writeRawAtomic(join(home, ".lock"), "released writer\n", true).pipe(
                    Effect.provideService(FileSystem.FileSystem, fs),
                  ),
                );
                assert.strictEqual(result._tag, "Failure");
                if (result._tag === "Failure")
                  assert.strictEqual(result.failure.reason._tag, "AlreadyExists");
                refused = true;
                return yield* Effect.fail(
                  systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "rename" }),
                );
              }
              yield* fs.rename(from, to);
            }),
        }),
      ),
    );
    assert.isTrue(refused);
    yield* fs.writeFileString(
      join(home, "state.json.v9.backup-database"),
      "backup was edited; never the retry authority",
    );
    yield* migrateLocalLibraryState(home);
    assert.isFalse(yield* fs.exists(join(home, ".lock")));
    assert.strictEqual(
      (yield* loadLibrary(home)).unmanaged[0]?.currentHash,
      legacy.unmanaged[0]?.observedHash,
    );
    yield* withLibraryDatabase(
      libraryDatabasePath(home),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          hash: string;
          fenced: number;
        }>`SELECT hash, fenced FROM library_import WHERE source='state.json'`;
        assert.match(rows[0]!.hash, /^sha256:[a-f0-9]{64}$/);
        assert.strictEqual(rows[0]!.fenced, 1);
      }),
      true,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a released edit during database preparation cannot be hidden by a later digest read",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-import-source-race-" });
      const statePath = join(home, "state.json");
      const original = JSON.stringify(legacy);
      const edited = JSON.stringify({ ...legacy, unmanaged: [] });
      yield* fs.writeFileString(statePath, original);
      let changed = false;
      const error = yield* Effect.flip(
        migrateLocalLibraryState(home).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFileString: (path, encoding) =>
              Effect.gen(function* () {
                const text = yield* fs.readFileString(path, encoding);
                if (path === statePath && !changed && (yield* fs.exists(join(home, ".lock")))) {
                  changed = true;
                  yield* fs.writeFileString(path, edited);
                }
                return text;
              }),
          }),
        ),
      );
      assert.isTrue(changed);
      assert.strictEqual(error._tag, "InvalidLibraryState");
      if (error._tag === "InvalidLibraryState")
        assert.strictEqual(error.reason._tag, "LegacySourceChanged");
      assert.strictEqual(yield* fs.readFileString(statePath), edited);
      assert.deepStrictEqual(
        yield* withLibraryDatabase(
          libraryDatabasePath(home),
          readDatabaseState(libraryDatabasePath(home)),
          true,
        ),
        { state: undefined, revision: null },
      );
      assert.strictEqual(
        yield* fs.readFileString(join(home, "state.json.v9.backup-database")),
        original,
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "distinguishes restored legacy state from an unfinished import without overwriting either",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-import-restored-" });
      const statePath = join(home, "state.json");
      const original = JSON.stringify(legacy);
      yield* fs.writeFileString(statePath, original);
      yield* migrateLocalLibraryState(home);
      const before = yield* loadLibrary(home);
      yield* fs.writeFileString(statePath, original);
      const error = yield* Effect.flip(migrateLocalLibraryState(home));
      assert.strictEqual(error._tag, "InvalidLibraryState");
      if (error._tag === "InvalidLibraryState")
        assert.deepStrictEqual(error.reason, {
          _tag: "LegacyStateBesideDatabase",
          statePath,
          databasePath: libraryDatabasePath(home),
        });
      assert.strictEqual(yield* fs.readFileString(statePath), original);
      assert.deepStrictEqual(yield* loadLibrary(home), before);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("reports a conflicting import backup with both source and backup paths", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-import-backup-conflict-" });
    const sourcePath = join(home, "state.json");
    const backupPath = join(home, "state.json.v9.backup-database");
    const original = JSON.stringify(legacy);
    yield* fs.writeFileString(sourcePath, original);
    yield* fs.writeFileString(backupPath, "independent backup");
    const error = yield* Effect.flip(migrateLocalLibraryState(home));
    assert.strictEqual(error._tag, "InvalidLibraryState");
    if (error._tag === "InvalidLibraryState")
      assert.deepStrictEqual(error.reason, {
        _tag: "ImportBackupChanged",
        sourcePath,
        backupPath,
        databasePath: libraryDatabasePath(home),
      });
    assert.strictEqual(yield* fs.readFileString(sourcePath), original);
    assert.strictEqual(yield* fs.readFileString(backupPath), "independent backup");
    assert.deepStrictEqual(
      yield* withLibraryDatabase(
        libraryDatabasePath(home),
        readDatabaseState(libraryDatabasePath(home)),
        true,
      ),
      { state: undefined, revision: null },
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("refuses newer database migrations with the known and observed versions", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-import-newer-database-" });
    yield* migrateLocalLibraryState(home, true);
    const path = libraryDatabasePath(home);
    // Simulate a database written by a later build; the current store cannot produce this ledger.
    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE effect_sql_migrations SET migration_id = 14 WHERE migration_id = 1`;
      }),
    );
    const error = yield* Effect.flip(migrateLocalLibraryState(home));
    assert.strictEqual(error._tag, "InvalidLibraryState");
    if (error._tag === "InvalidLibraryState")
      assert.deepStrictEqual(error.reason, {
        _tag: "NewerDatabaseMigration",
        databasePath: path,
        migration: 14,
        supported: 13,
      });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("revalidates a database that appeared after the initial probe", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-database-after-probe-" });
    yield* prepareLibraryDatabase(home, true);
    const path = libraryDatabasePath(home);
    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE effect_sql_migrations SET name='unexpected' WHERE migration_id=1`;
      }),
    );
    let probed = false;
    const error = yield* prepareLibraryDatabase(home, true).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        exists: (candidate) =>
          Effect.suspend(() => {
            if (candidate !== path || probed) return fs.exists(candidate);
            probed = true;
            return Effect.succeed(false);
          }),
      }),
      Effect.flip,
    );
    assert.strictEqual(error._tag, "InvalidLibraryState");
    if (error._tag === "InvalidLibraryState") assert.strictEqual(error.reason._tag, "InvalidData");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("keeps native SQL and migration causes in a database failure", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-native-sql-error-" });
    const path = libraryDatabasePath(home);
    yield* migrateLocalLibraryState(home, true);
    const native = new SqlError({
      reason: classifySqliteError(new Error("fixture native failure")),
    });
    const error = yield* Effect.flip(withLibraryDatabase(path, Effect.fail(native)));
    assert.strictEqual(error._tag, "LibrarySqlError");
    if (error._tag === "LibrarySqlError") {
      assert.strictEqual(error.path, path);
      assert.strictEqual(error.cause, native);
    }
    // Impossible partial schema: ensure the actual Migrator failure also stays native.
    const partial = join(home, "partial.sqlite");
    const failed = yield* Effect.flip(
      withLibraryDatabase(
        partial,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE library_collections (id INTEGER)`;
          yield* migrateLibraryDatabase(partial);
        }),
      ),
    );
    assert.strictEqual(failed._tag, "LibrarySqlError");
    if (failed._tag === "LibrarySqlError") {
      assert.strictEqual(failed.path, partial);
      assert.isTrue(Schema.is(Schema.TaggedStruct("MigrationError", {}))(failed.cause));
    }
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("reports orphaned operation rows without a current state document", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-orphaned-operation-" });
    yield* migrateLocalLibraryState(home, true);
    const path = libraryDatabasePath(home);
    // A current transaction cannot leave operation rows without their state document.
    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO library_operations (position, operation_id, document) VALUES (0, 'orphan', '{}')`;
      }),
    );
    const error = yield* Effect.flip(loadLibrary(home));
    assert.strictEqual(error._tag, "InvalidLibraryState");
    if (error._tag === "InvalidLibraryState")
      assert.deepStrictEqual(error.reason, { _tag: "OperationStateMissing", databasePath: path });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const changed of [false, true])
  it.effect(
    `imports a legacy draft beside an audit identity: ${changed ? "refuses changed content" : "keeps one event"}`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-legacy-audit-identity-" });
        const event = yield* LibraryAuditEvent.makeEffect({
          schemaVersion: 1,
          eventId: makeOperationId(),
          occurredAt: "2026-11-05T00:00:00.000Z",
          type: "library.imported",
          workflow: "legacy-import",
          changes: [{ entity: "library", id: "legacy", action: "operation-Done" }],
        });
        const original = JSON.stringify({
          ...emptyLibraryState(),
          historyDelivery: {
            schemaVersion: 1,
            pending: [
              {
                event: { ...event, workflow: changed ? "changed-content" : event.workflow },
                operationIds: [],
              },
            ],
          },
        });
        const audit = JSON.stringify(event) + "\n";
        yield* fs.writeFileString(join(home, "state.json"), original);
        yield* fs.writeFileString(join(home, "audit.jsonl"), audit);
        if (changed) {
          const failed = yield* migrateLocalLibraryState(home).pipe(Effect.flip);
          assert.strictEqual(failed._tag, "LibraryAuditInvalid");
          if (failed._tag === "LibraryAuditInvalid")
            assert.strictEqual(failed.reason._tag, "EventIdentityChanged");
          assert.deepStrictEqual(
            yield* withLibraryDatabase(
              libraryDatabasePath(home),
              readDatabaseState(libraryDatabasePath(home)),
              true,
            ),
            { state: undefined, revision: null },
          );
          assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), original);
        } else {
          yield* migrateLocalLibraryState(home);
          assert.deepStrictEqual(yield* readLibraryAudit(home), [event]);
        }
        assert.strictEqual(yield* fs.readFileString(join(home, "audit.jsonl")), audit);
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

/** The exact document-backed schema from migration 001, before revision activation. */
const documentDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-document-conversion-" });
  const path = libraryDatabasePath(home);
  const { state } = yield* valuesFixture;
  const pending = OperationStatus.cases.Pending.make({
    operationId: makeOperationId(),
    steps: [
      {
        step: {
          _tag: "Undo",
          program: {
            operationId: "fixture-prior-operation",
            backupId: "87362930-1a1f-4c45-88f0-02727023ca67",
            difference: yield* prepareLibraryDifference(state, state, home),
            files: [],
            paths: [],
            sources: [],
            sourceImports: [],
            actions: [],
            preserve: [],
            preserved: false,
          },
        },
        before: [],
        after: [],
        status: "Pending",
      },
    ],
    before: recordedLibrary(state),
  });
  const event = yield* LibraryAuditEvent.makeEffect({
    schemaVersion: 1,
    eventId: makeOperationId(),
    occurredAt: "2026-11-16T00:00:00.000Z",
    type: "library.imported",
    workflow: "fixture",
    changes: [],
  });
  const document = JSON.stringify(state);
  const program = yield* Schema.encodeEffect(Schema.fromJsonString(OperationStatus))(pending);
  const audit = JSON.stringify(event);
  yield* withLibraryDatabase(
    path,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migrator.make({})({
        loader: Migrator.fromRecord({
          "001_library": Effect.gen(function* () {
            yield* sql`CREATE TABLE library_state (id INTEGER PRIMARY KEY CHECK (id = 1), document TEXT NOT NULL)`;
            yield* sql`CREATE TABLE library_operations (position INTEGER PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, kind TEXT, document TEXT NOT NULL)`;
            yield* sql`CREATE TABLE library_audit_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, document TEXT NOT NULL, operation_ids TEXT NOT NULL DEFAULT '[]')`;
            yield* sql`CREATE TABLE library_import (id INTEGER PRIMARY KEY CHECK (id = 1), state_backup TEXT, audit_backup TEXT, state_hash TEXT, audit_hash TEXT, fenced INTEGER NOT NULL DEFAULT 0)`;
          }),
        }),
      });
      yield* sql`INSERT INTO library_state (id, document) VALUES (1, ${document})`;
      yield* sql`INSERT INTO library_operations (position, operation_id, kind, document)
      VALUES (0, ${pending.operationId}, 'setup', ${program})`;
      yield* sql`INSERT INTO library_audit_events (event_id, document) VALUES (${event.eventId}, ${audit})`;
    }),
  );
  yield* fs.writeFileString(
    join(home, "state.json"),
    JSON.stringify({ schemaVersion: 13 }, null, 2) + "\n",
  );
  return { home, path, state, document, pending, program, event, audit };
});

const revisionContents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    device: yield* sql`SELECT * FROM library_device ORDER BY id`,
    inventory: yield* sql`SELECT * FROM library_inventory ORDER BY id`,
    operations: yield* sql`SELECT * FROM library_operations ORDER BY position`,
    audit: yield* sql`SELECT * FROM library_audit_events ORDER BY sequence`,
  };
});

for (const bad of ["document", "migration"])
  it.effect("refuses an invalid existing database intact: " + bad, () =>
    Effect.gen(function* () {
      const f = yield* documentDatabase;
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          if (bad === "document")
            yield* sql`UPDATE library_state SET document = '{"schemaVersion":12}'`;
          else yield* sql`UPDATE effect_sql_migrations SET name = 'unknown' WHERE migration_id = 1`;
        }),
      );
      const before = yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return {
            state: yield* sql`SELECT * FROM library_state`,
            operations: yield* sql`SELECT * FROM library_operations`,
            audit: yield* sql`SELECT * FROM library_audit_events`,
            migrations: yield* sql`SELECT * FROM effect_sql_migrations`,
          };
        }),
      );
      const failed = yield* Effect.flip(migrateLocalLibraryState(f.home));
      assert.strictEqual(failed._tag, "InvalidLibraryState");
      const after = yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.strictEqual(
            (yield* sql`SELECT name FROM sqlite_master WHERE name IN
          ('library_blobs','library_revisions','library_head')`).length,
            0,
          );
          return {
            state: yield* sql`SELECT * FROM library_state`,
            operations: yield* sql`SELECT * FROM library_operations`,
            audit: yield* sql`SELECT * FROM library_audit_events`,
            migrations: yield* sql`SELECT * FROM effect_sql_migrations`,
          };
        }),
      );
      assert.deepStrictEqual(after, before);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("a late audit failure rolls back Library rows and operation program together", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-publication-rollback-" });
    const state = emptyLibraryState();
    const pending = OperationStatus.cases.Pending.make({
      operationId: makeOperationId(),
      steps: [],
      before: { installedSkills: [] },
      setup: { changes: yield* prepareSetupChanges(setupIntent(state), setupIntent(state), home) },
    });
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        yield* (yield* LibraryWriter).recordOperation(
          pending,
          snapshotOf({ present: false }),
          "setup",
        );
      }),
    );
    const path = libraryDatabasePath(home);
    const before = yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql.withTransaction(revisionContents);
        yield* sql`CREATE TRIGGER audit_failure BEFORE INSERT ON library_audit_events
        BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`;
        return rows;
      }),
    );
    const failed = yield* Effect.flip(
      writeLibrary(
        home,
        Effect.gen(function* () {
          yield* (yield* LibraryWriter).saveOperation(
            { ...pending, preparation: { roots: [], done: true } },
            pending,
            {
              base: state,
              next: {
                ...state,
                scanIssues: [{ path: "/new", harness: "codex", code: "MISSING_ROOT" }],
              },
            },
          );
        }),
      ),
    );
    assert.strictEqual(failed._tag, "LibrarySqlError");
    const after = yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.withTransaction(revisionContents);
      }),
    );
    assert.deepStrictEqual(after, before);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a read-only open refuses a migration-1 database without attempting conversion", () =>
  Effect.gen(function* () {
    const f = yield* documentDatabase;
    const failed = yield* Effect.flip(withLibraryDatabase(f.path, readDatabaseState(f.path), true));
    assert.strictEqual(failed._tag, "LibrarySqlError");
    yield* withLibraryDatabase(
      f.path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(yield* sql`SELECT document FROM library_state`, [
          { document: JSON.stringify(f.state) },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT document FROM library_operations`, [
          { document: f.program },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT migration_id, name FROM effect_sql_migrations`, [
          { migration_id: 1, name: "library" },
        ]);
        assert.strictEqual(
          (yield* sql`SELECT name FROM sqlite_master WHERE name = 'library_head'`).length,
          0,
        );
      }),
      true,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("shared writes refuse a pre-existing transaction without home writer authority", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-unlocked-transaction-" });
    yield* prepareLibraryDatabase(home, true);
    yield* withLibraryDatabase(
      libraryDatabasePath(home),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const failure = yield* Effect.flip(
              withDatabaseTransaction(
                home,
                sql`INSERT INTO library_collections(collection_id,label) VALUES('unlocked','unlocked')`,
              ),
            );
            assert.strictEqual(failure._tag, "InvalidLibraryState");
            assert.deepStrictEqual(yield* sql`SELECT collection_id FROM library_collections`, []);
          }),
        );
      }),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "writes nested in a read snapshot use a separate writer and leave the snapshot stable",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-read-write-nesting-" });
      yield* migrateLocalLibraryState(home, true);
      const path = libraryDatabasePath(home);
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE nested_write (value TEXT NOT NULL)`;
        }),
      );
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const reader = yield* SqlClient.SqlClient;
          yield* reader.withTransaction(
            Effect.gen(function* () {
              assert.deepStrictEqual(yield* reader`SELECT value FROM nested_write`, []);
              yield* withDatabaseTransaction(
                home,
                Effect.gen(function* () {
                  const writer = yield* SqlClient.SqlClient;
                  assert.notStrictEqual(writer, reader);
                  yield* writer`INSERT INTO nested_write(value) VALUES('committed')`;
                }),
              );
              assert.deepStrictEqual(yield* reader`SELECT value FROM nested_write`, []);
            }),
          );
          assert.deepStrictEqual(yield* reader`SELECT value FROM nested_write`, [
            { value: "committed" },
          ]);
        }),
        true,
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
