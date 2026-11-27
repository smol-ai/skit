import { saveLibrary } from "./helpers/library-store.js";
import { inspectLocalLibraryState } from "../src/library/store/state-file.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { declaredFixture as fixture } from "./helpers/library-values.js";
import { skitLayer } from "../src/platform/layer.js";
import {
  LibraryWriter,
  loadLibrary,
  loadOperation,
  writeLibrary,
} from "../src/library/store/library-store.js";
import { readCatalogue } from "../src/library/store/catalogue.js";
import { migrateLocalLibraryState } from "../src/library/store/state-file.js";
import { libraryDatabasePath, withLibraryDatabase } from "../src/library/database.js";
import { readLibraryAudit, LibraryAuditEvent } from "../src/library/audit/audit-log.js";
import { diffLibraryState } from "../src/library/audit/state-diff.js";
import { libraryStateRevision } from "../src/library/library-state.js";
import { snapshotOf } from "../src/library/snapshot.js";
import { OperationStatus } from "../src/library/store/state-schema.js";
import { CurrentSetupOperation } from "../src/library/store/setup-intent.js";
import { makeOperationId } from "../src/library/entity-ids.js";

const prepared = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-remove-rows-" });
  const { state } = yield* fixture;
  yield* saveLibrary(home, state);
  yield* migrateLocalLibraryState(home);
  const collection = state.collections[0]!;
  const remainingImports = state.imports.filter(
    (row) => row.collection_id !== collection.collection_id,
  );
  const versions = new Set(remainingImports.map((row) => row.collection_version_id));
  const { invocation_policies: _policies, ...rest } = state;
  const expected = {
    ...rest,
    collections: state.collections.slice(1),
    skills: state.skills.filter((row) => row.collection_id !== collection.collection_id),
    imports: remainingImports,
    collection_versions: state.collection_versions.filter((row) =>
      versions.has(row.collection_version_id),
    ),
    enabled: [],
    repositories: [],
    installed_skills: state.installed_skills.slice(1),
  };
  const pending = OperationStatus.cases.Pending.make({
    operationId: makeOperationId(),
    before: { installedSkills: state.installed_skills },
    steps: [{ step: { _tag: "Remove", folders: [] }, before: [], after: [], status: "Pending" }],
    setup: { changes: { scopes: [], sources: [], memberships: [], versions: [] } },
  });
  yield* writeLibrary(
    home,
    Effect.gen(function* () {
      yield* (yield* LibraryWriter).recordOperation(
        pending,
        snapshotOf(yield* inspectLocalLibraryState(home)),
        "setup",
      );
    }),
  );
  const operation = Option.getOrUndefined(yield* loadOperation(home, pending.operationId));
  if (operation?._tag !== "Pending") return yield* Effect.die("Missing operation");
  const progress = { ...operation, preparation: { roots: [], done: true } };
  const revision = (yield* readCatalogue(home)).revision!;
  const publication = {
    removeCollection: collection.collection_id,
    revision,
    installedSkills: { base: state.installed_skills, next: expected.installed_skills },
  };
  return {
    home,
    state,
    expected,
    collection,
    operation,
    progress,
    publication,
    path: libraryDatabasePath(home),
  };
});

it.effect(
  "collection removal publishes exact remaining facts, agreed ancestry, setup progress and audit",
  () =>
    Effect.gen(function* () {
      const { home, state, expected, operation, progress, publication, path } = yield* prepared;
      const beforeHistory = yield* readLibraryAudit(home);
      const previousEventIds = new Set(beforeHistory.map((event) => event.eventId));
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          yield* writer
            .saveOperation(progress, operation, publication)
            .pipe(Effect.provideService(CurrentSetupOperation, operation.operationId));
          const after = yield* loadLibrary(home);
          assert.strictEqual(libraryStateRevision(after), libraryStateRevision(expected));
          assert.deepStrictEqual(after.sync_ancestry, state.sync_ancestry);
          assert.strictEqual(after.collections.length, 31);
          assert.strictEqual(after.collection_versions.length, 34);
          assert.strictEqual(after.installed_skills.length, 7);
          assert.deepStrictEqual(yield* readLibraryAudit(home), beforeHistory);
          const changes = yield* withLibraryDatabase(
            path,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const rows = yield* sql<{
                document: string;
              }>`SELECT document FROM library_audit_events ORDER BY sequence`;
              const events = yield* Effect.forEach(rows, (row) =>
                Schema.decodeEffect(Schema.fromJsonString(LibraryAuditEvent))(row.document),
              );
              return events
                .filter((event) => !previousEventIds.has(event.eventId))
                .flatMap((event) => event.changes)
                .filter((change) => !change.action.startsWith("operation-"));
            }),
            true,
          );
          assert.deepStrictEqual(changes, diffLibraryState(state, expected));
          const saved = Option.getOrUndefined(yield* loadOperation(home, operation.operationId));
          if (saved?._tag !== "Pending") return yield* Effect.die("Missing progress");
          assert.isTrue(saved.preparation?.done === true);
          assert.strictEqual(saved.setup?.changes.sources.length, 1);
          assert.strictEqual(saved.setup?.changes.scopes.length, 2);
          const revision = yield* writer.revision;
          assert.strictEqual(revision, publication.revision + 1);
          const repeated = {
            ...publication,
            revision,
            installedSkills: { base: after.installed_skills, next: after.installed_skills },
          };
          // A still-Pending record can resume after domain publication already reached its after side.
          yield* writer.saveOperation(saved, saved, repeated);
          assert.strictEqual(yield* writer.revision, revision);
          assert.strictEqual(
            (yield* Effect.flip(writer.saveOperation(saved, saved, publication)))._tag,
            "LibraryChanged",
          );
        }),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const refusal of ["audit", "setup", "operation"])
  it.effect(
    `refused ${refusal} rolls back catalogue, choices, installed rows, ancestry and progress together`,
    () =>
      Effect.gen(function* () {
        const { home, state, operation, progress, publication, path } = yield* prepared;
        const history = yield* readLibraryAudit(home);
        yield* withLibraryDatabase(
          path,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            if (refusal === "audit")
              yield* sql`CREATE TRIGGER refuse_remove_audit BEFORE INSERT ON library_audit_events BEGIN SELECT RAISE(ABORT,'audit refusal'); END`;
            else if (refusal === "setup")
              yield* sql`CREATE TRIGGER refuse_remove_setup BEFORE UPDATE ON library_operations BEGIN SELECT RAISE(ABORT,'setup refusal'); END`;
            else
              yield* sql`CREATE TRIGGER refuse_remove_progress BEFORE UPDATE ON library_operations WHEN json_extract(NEW.document,'$.preparation.done')=1 BEGIN SELECT RAISE(ABORT,'progress refusal'); END`;
          }),
        );
        yield* writeLibrary(
          home,
          Effect.gen(function* () {
            const writer = yield* LibraryWriter;
            const result = yield* Effect.flip(
              writer
                .saveOperation(progress, operation, publication)
                .pipe(Effect.provideService(CurrentSetupOperation, operation.operationId)),
            );
            assert.strictEqual(result._tag, "LibrarySqlError");
            assert.strictEqual(yield* writer.revision, publication.revision);
          }),
        );
        assert.strictEqual(
          libraryStateRevision(yield* loadLibrary(home)),
          libraryStateRevision(state),
        );
        assert.deepStrictEqual(
          yield* loadOperation(home, operation.operationId),
          Option.some(operation),
        );
        assert.deepStrictEqual(yield* readLibraryAudit(home), history);
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("collection removal does not need scan or security rows", () =>
  Effect.gen(function* () {
    const { home, expected, collection, operation, progress, publication, path } = yield* prepared;
    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP TABLE library_inventory`;
        yield* sql`DROP TABLE library_assessment_acceptances`;
      }),
    );
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        yield* (yield* LibraryWriter).saveOperation(progress, operation, publication);
      }),
    );
    const after = yield* readCatalogue(home);
    assert.isFalse(
      after.value.collections.some((row) => row.collection_id === collection.collection_id),
    );
    assert.deepStrictEqual(after.value.skills, expected.skills);
    assert.strictEqual((yield* Effect.flip(loadLibrary(home)))._tag, "LibrarySqlError");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a collection with a surviving installed copy is refused before any rows change", () =>
  Effect.gen(function* () {
    const { home, state, operation, progress, publication } = yield* prepared;
    const history = yield* readLibraryAudit(home);
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        const failure = yield* Effect.flip(
          writer.saveOperation(progress, operation, {
            ...publication,
            installedSkills: { base: state.installed_skills, next: state.installed_skills },
          }),
        );
        assert.strictEqual(failure._tag, "InvalidLibraryState");
        assert.strictEqual(yield* writer.revision, publication.revision);
      }),
    );
    assert.strictEqual(libraryStateRevision(yield* loadLibrary(home)), libraryStateRevision(state));
    assert.deepStrictEqual(
      yield* loadOperation(home, operation.operationId),
      Option.some(operation),
    );
    assert.deepStrictEqual(yield* readLibraryAudit(home), history);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
