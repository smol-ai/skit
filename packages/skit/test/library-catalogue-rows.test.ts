import { saveLibrary } from "./helpers/library-store.js";
import { normalizeCatalogue } from "../src/library/manifest.js";
import { inspectLocalLibraryState } from "../src/library/store/state-file.js";
import { SkillVersion } from "../src/library/library-contracts.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Struct, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
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
import { libraryDatabasePath, withLibraryDatabase } from "../src/library/store/database.js";
import { readLibraryAudit } from "../src/library/audit/audit-log.js";
import { canonicalJson } from "../src/shared/json.js";
import { decodeLibraryState, emptyLibraryState } from "../src/library/library-state.js";
import { snapshotOf } from "../src/library/snapshot.js";
import { OperationStatus } from "../src/library/store/state-schema.js";
import { CurrentSetupOperation } from "../src/library/store/setup-intent.js";
import { makeOperationId, makeImportId } from "../src/library/entity-ids.js";

const fields = ["collections", "skills", "collection_versions", "imports"] as const;
const prepared = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-catalogue-rows-" });
  const { state, future } = yield* fixture;
  yield* saveLibrary(home, state);
  yield* migrateLocalLibraryState(home);
  const stored = yield* readCatalogue(home);
  return { home, state, future, stored, path: libraryDatabasePath(home) };
});

const baseRows = (path: string) =>
  withLibraryDatabase(
    path,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{
        entity: string;
        key: string;
        change: string;
        value: string | null;
      }>`SELECT entity,key,change,value FROM library_sync_base WHERE entity IN ('collections','skills','collection_versions','imports','collections.order','skills.order','collection_versions.order','imports.order')`;
    }),
    true,
  );

it.effect("catalogue reads and writes need no installed, scan or security tables", () =>
  Effect.gen(function* () {
    const { home, stored, path } = yield* prepared;
    const originalBase = yield* baseRows(path);
    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP TABLE library_installed_skills`;
        yield* sql`DROP TABLE library_inventory`;
        yield* sql`DROP TABLE library_assessment_acceptances`;
      }),
    );
    const next = {
      ...stored.value,
      collections: stored.value.collections.map((row, index) =>
        index === 0 ? { ...row, label: "Changed label" } : row,
      ),
    };
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        assert.strictEqual(
          yield* (yield* LibraryWriter).saveCatalogue(next, stored.value, stored.revision),
          stored.revision! + 1,
        );
      }),
    );
    assert.deepStrictEqual((yield* readCatalogue(home)).value, next);
    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          key: string;
        }>`SELECT key FROM library_sync_base WHERE entity='collections'`;
        assert.deepStrictEqual(
          rows.map((row) => row.key).sort(),
          [
            ...new Set([
              ...originalBase.filter((row) => row.entity === "collections").map((row) => row.key),
              stored.value.collections[0]!.collection_id,
            ]),
          ].sort(),
        );
      }),
      true,
    );
    assert.strictEqual((yield* Effect.flip(loadLibrary(home)))._tag, "LibrarySqlError");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "catalogue changes preserve agreed values and ignore input order across successive imports",
  () =>
    Effect.gen(function* () {
      const { home, state, stored, path } = yield* prepared;
      const originalBase = yield* baseRows(path);
      const imported = {
        ...stored.value.imports[0]!,
        import_id: makeImportId(),
        imported_at: "2026-11-17T00:00:00Z",
      };
      const next = {
        collections: stored.value.collections
          .map((row, index) => (index === 0 ? { ...row, label: "Changed" } : row))
          .reverse(),
        skills: stored.value.skills
          .map((row, index) => (index === 0 ? { ...row, name: row.name + "-changed" } : row))
          .reverse(),
        collection_versions: [...stored.value.collection_versions].reverse(),
        imports: [...stored.value.imports].reverse().concat(imported),
      };
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          const reordered = { ...stored.value, skills: stored.value.skills.toReversed() };
          assert.strictEqual(
            yield* writer.saveCatalogue(reordered, stored.value, stored.revision),
            stored.revision,
          );
          const revision = yield* writer.saveCatalogue(next, stored.value, stored.revision);
          const loaded = yield* loadLibrary(home);
          assert.deepStrictEqual(loaded.sync_ancestry, state.sync_ancestry);
          assert.deepStrictEqual(Struct.pick(loaded, fields), normalizeCatalogue(next));
          const restored = { ...stored.value, imports: [...stored.value.imports, imported] };
          yield* writer.saveCatalogue(restored, next, revision);
          const final = yield* loadLibrary(home);
          assert.deepStrictEqual(final.sync_ancestry, state.sync_ancestry);
          assert.deepStrictEqual(Struct.pick(final, fields), normalizeCatalogue(restored));
          yield* withLibraryDatabase(
            path,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const rows =
                yield* sql`SELECT entity,key,change,value FROM library_sync_base WHERE entity IN ('collections','skills','collection_versions','imports','collections.order','skills.order','collection_versions.order','imports.order')`;
              assert.deepStrictEqual(
                rows.map(canonicalJson).sort(),
                [
                  ...originalBase,
                  { entity: "imports", key: imported.import_id, change: "added", value: null },
                ]
                  .map(canonicalJson)
                  .sort(),
              );
            }),
            true,
          );
        }),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "catalogue writes refuse stale revisions and changes to immutable imports or Versions",
  () =>
    Effect.gen(function* () {
      const { home, stored } = yield* prepared;
      const next = {
        ...stored.value,
        collections: stored.value.collections.map((row, index) =>
          index === 0 ? { ...row, label: "Changed" } : row,
        ),
      };
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          const reordered = { ...stored.value, skills: stored.value.skills.toReversed() };
          assert.strictEqual(
            yield* writer.saveCatalogue(reordered, stored.value, stored.revision),
            stored.revision,
          );
          const revision = yield* writer.saveCatalogue(next, stored.value, stored.revision);
          assert.strictEqual(yield* writer.saveCatalogue(next, next, revision), revision);
          assert.strictEqual(
            (yield* Effect.flip(writer.saveCatalogue(stored.value, next, stored.revision)))._tag,
            "LibraryChanged",
          );
          const changedImport = {
            ...next,
            imports: next.imports.map((row, index) =>
              index === 0 ? { ...row, input: { value: "/invented" } } : row,
            ),
          };
          assert.strictEqual(
            (yield* Effect.flip(writer.saveCatalogue(changedImport, next, revision)))._tag,
            "InvalidLibraryState",
          );
          const changedVersion = {
            ...next,
            skills: next.skills.map((row, index) =>
              index === 0
                ? {
                    ...row,
                    versions: row.versions.map((version) => ({
                      ...version,
                      materialization_profile: "plain-skill/v1" as const,
                    })),
                  }
                : row,
            ),
          };
          // A known Version's original unknown fields are immutable too.
          const version = changedVersion.skills[0]!.versions[0]!;
          Object.defineProperty(version, "extension", {
            value: { replaced: true },
            enumerable: true,
            configurable: true,
          });
          assert.strictEqual(
            (yield* Effect.flip(writer.saveCatalogue(changedVersion, next, revision)))._tag,
            "InvalidLibraryState",
          );
          assert.strictEqual(yield* writer.revision, revision);
          assert.deepStrictEqual((yield* readCatalogue(home)).value, next);
        }),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const refusal of ["none", "setup", "audit"])
  it.effect(
    `catalogue, ancestry, setup Undo progress, revision and audit commit atomically (refusal=${refusal})`,
    () =>
      Effect.gen(function* () {
        const { home, state, future, stored, path } = yield* prepared;
        if (!future) return yield* Effect.die("Missing backed Version");
        const version = yield* Schema.decodeUnknownEffect(Schema.declare(Schema.is(SkillVersion)))(
          future,
        );
        const next = {
          ...stored.value,
          skills: stored.value.skills.map((row, index) =>
            index === 0
              ? {
                  ...row,
                  local_version_id: version.skill_version_id,
                  versions: [...row.versions, version],
                }
              : row,
          ),
        };
        const pending = OperationStatus.cases.Pending.make({
          operationId: makeOperationId(),
          before: { installedSkills: [] },
          steps: [
            { step: { _tag: "Remove", folders: [] }, before: [], after: [], status: "Pending" },
          ],
          setup: { changes: { scopes: [], sources: [], memberships: [], versions: [] } },
        });
        yield* writeLibrary(
          home,
          Effect.gen(function* () {
            const writer = yield* LibraryWriter;
            yield* writer.recordOperation(
              pending,
              snapshotOf(yield* inspectLocalLibraryState(home)),
              "setup",
            );
            const operation = yield* loadOperation(home, pending.operationId);
            const history = yield* readLibraryAudit(home);
            if (refusal !== "none")
              yield* withLibraryDatabase(
                path,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  if (refusal === "setup")
                    yield* sql`CREATE TRIGGER refuse_catalogue_setup BEFORE UPDATE ON library_operations BEGIN SELECT RAISE(ABORT,'setup refusal'); END`;
                  else
                    yield* sql`CREATE TRIGGER refuse_catalogue_audit BEFORE INSERT ON library_audit_events BEGIN SELECT RAISE(ABORT,'audit refusal'); END`;
                }),
              );
            const save = writer
              .saveCatalogue(next, stored.value, stored.revision)
              .pipe(Effect.provideService(CurrentSetupOperation, pending.operationId));
            if (refusal === "none") {
              yield* save;
              const saved = Option.getOrUndefined(yield* loadOperation(home, pending.operationId));
              if (saved?._tag !== "Pending") return yield* Effect.die("Missing operation");
              assert.strictEqual(saved.setup?.changes.versions.length, 1);
              assert.strictEqual(
                saved.setup?.changes.versions[0]?.after?.local,
                version.skill_version_id,
              );
              assert.deepStrictEqual((yield* loadLibrary(home)).sync_ancestry, state.sync_ancestry);
            } else {
              assert.strictEqual((yield* Effect.flip(save))._tag, "LibrarySqlError");
              assert.strictEqual(yield* writer.revision, stored.revision);
              assert.deepStrictEqual(yield* loadLibrary(home), state);
              assert.deepStrictEqual(yield* loadOperation(home, pending.operationId), operation);
              assert.deepStrictEqual(yield* readLibraryAudit(home), history);
            }
          }),
        );
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect(
  "an absent Library imports catalogue facts without inventing prior state or ancestry",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = join(
        yield* fs.makeTempDirectoryScoped({ prefix: "skit-cold-catalogue-" }),
        "home",
      );
      const { state } = yield* fixture;
      const before = yield* readCatalogue(home);
      assert.strictEqual(before.revision, null);
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          yield* (yield* LibraryWriter).saveCatalogue(
            Struct.pick(state, fields),
            before.value,
            before.revision,
          );
        }),
      );
      const loaded = yield* loadLibrary(home);
      assert.strictEqual(
        canonicalJson(loaded),
        canonicalJson({ ...emptyLibraryState(), ...Struct.pick(state, fields) }),
      );
      assert.isUndefined(loaded.sync_ancestry);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("malformed catalogue JSON is refused as a typed Library error without writing", () =>
  Effect.gen(function* () {
    const { home, stored, path } = yield* prepared;
    const history = yield* readLibraryAudit(home);
    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA ignore_check_constraints=ON`;
        yield* sql`UPDATE library_collections SET upstream='{broken' WHERE collection_id=${stored.value.collections[0]!.collection_id}`;
        yield* sql`PRAGMA ignore_check_constraints=OFF`;
      }),
    );
    const failure = yield* Effect.flip(readCatalogue(home));
    assert.strictEqual(failure._tag, "InvalidLibraryState");
    if (failure._tag === "InvalidLibraryState")
      assert.strictEqual(failure.reason._tag, "SchemaInvalid");
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        assert.strictEqual(
          (yield* Effect.flip(writer.saveCatalogue(stored.value, stored.value, stored.revision)))
            ._tag,
          "InvalidLibraryState",
        );
        assert.strictEqual(yield* writer.revision, stored.revision);
      }),
    );
    assert.deepStrictEqual(yield* readLibraryAudit(home), history);
    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql<{
          upstream: string;
        }>`SELECT upstream FROM library_collections WHERE collection_id=${stored.value.collections[0]!.collection_id}`;
        assert.strictEqual(row?.upstream, "{broken");
      }),
      true,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const rollback of [false, true])
  it.effect(
    `catalogue path swaps ${rollback ? "roll back dependent Versions and audit on failure" : "keep dependent Versions valid under deferred foreign keys"}`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-catalogue-swap-" });
        const { state: original } = yield* fixture;
        const left = original.skills[0]!;
        const right = original.skills[32]!;
        assert.strictEqual(left.collection_id, right.collection_id);
        const content = left.versions[0]!;
        // Both paths contain identical bytes, so either Skill's immutable Version has source backing after the swap.
        const seed = yield* decodeLibraryState({
          ...original,
          skills: original.skills.map((skill) =>
            skill.skill_id === right.skill_id
              ? {
                  ...skill,
                  versions: skill.versions.map((version) => ({
                    ...version,
                    source_hash: content.source_hash,
                    artifact_hash: content.artifact_hash,
                    validation_identity_hash: content.validation_identity_hash,
                  })),
                }
              : skill,
          ),
          collection_versions: original.collection_versions.map((copy) => ({
            ...copy,
            members: copy.members.map((member) =>
              member.source_path === right.path
                ? {
                    ...member,
                    source_hash: content.source_hash,
                    artifact_hash: content.artifact_hash,
                  }
                : member,
            ),
          })),
        });
        yield* saveLibrary(home, seed);
        yield* migrateLocalLibraryState(home);
        const path = libraryDatabasePath(home);
        const before = yield* readCatalogue(home);
        const next = {
          ...before.value,
          skills: before.value.skills.map((skill) =>
            skill.skill_id === left.skill_id
              ? { ...skill, path: right.path }
              : skill.skill_id === right.skill_id
                ? { ...skill, path: left.path }
                : skill,
          ),
        };
        const audit = yield* readLibraryAudit(home);
        const acceptedBase = yield* baseRows(path);
        const versions = yield* withLibraryDatabase(
          path,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const rows = yield* sql`SELECT * FROM library_skill_versions ORDER BY skill_version_id`;
            if (rollback)
              yield* sql`CREATE TRIGGER refuse_skill_swap BEFORE INSERT ON library_skills WHEN NEW.path='skill-0' BEGIN SELECT RAISE(ABORT,'skill swap refused'); END`;
            return rows;
          }),
        );
        yield* writeLibrary(
          home,
          Effect.gen(function* () {
            const writer = yield* LibraryWriter;
            const save = writer.saveCatalogue(next, before.value, before.revision);
            if (rollback) {
              assert.strictEqual((yield* Effect.flip(save))._tag, "LibrarySqlError");
              assert.strictEqual(yield* writer.revision, before.revision);
            } else assert.strictEqual(yield* save, before.revision! + 1);
          }),
        );
        assert.strictEqual(
          canonicalJson((yield* readCatalogue(home)).value),
          canonicalJson(rollback ? before.value : normalizeCatalogue(next)),
        );
        const expected = rollback ? seed : { ...seed, ...next };
        assert.strictEqual(canonicalJson(yield* loadLibrary(home)), canonicalJson(expected));
        yield* withLibraryDatabase(
          path,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.deepStrictEqual(
              yield* sql`SELECT * FROM library_skill_versions ORDER BY skill_version_id`,
              versions,
            );
            assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
          }),
          true,
        );
        if (rollback) {
          assert.deepStrictEqual(yield* readLibraryAudit(home), audit);
          assert.deepStrictEqual(yield* baseRows(path), acceptedBase);
        }
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
