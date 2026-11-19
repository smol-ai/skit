import { inspectLocalLibraryState } from "../src/library/store/state-file.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
import { fixture } from "./helpers/library-values.js";
import { skitLayer } from "../src/platform/layer.js";
import {
  LibraryWriter,
  loadLibrary,
  loadOperation,
  writeLibrary,
} from "../src/library/store/library-store.js";
import { migrateLocalLibraryState } from "../src/library/store/state-file.js";
import { libraryDatabasePath, withLibraryDatabase } from "../src/library/store/database.js";
import { loadEnabledRows } from "../src/library/store/rows.js";
import { readLibraryAudit } from "../src/library/audit/audit-log.js";
import { diffLibraryState } from "../src/library/audit/state-diff.js";
import { canonicalJson } from "../src/shared/json.js";
import { decodeLibraryState, type LibraryState } from "../src/library/library-state.js";
import { snapshotOf } from "../src/library/snapshot.js";
import { OperationStatus } from "../src/library/store/state-schema.js";
import { CurrentSetupOperation } from "../src/library/store/setup-intent.js";
import { deviceInstallationIntent } from "../src/library/enabled.js";
import { makeOperationId, makeSkillId, makeCollectionId } from "../src/library/entity-ids.js";

const prepared = (ancestry = true) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-enabled-rows-" });
    const { state: full } = yield* fixture;
    const { sync_ancestry: _ancestry, ...withoutAncestry } = full;
    const state: LibraryState = ancestry ? full : withoutAncestry;
    yield* fs.writeFileString(join(home, "state.json"), JSON.stringify(state));
    yield* migrateLocalLibraryState(home);
    const first = state.skills[0];
    if (!first) return yield* Effect.die("Missing Skill");
    return { home, state, first, path: libraryDatabasePath(home) };
  });
const pending = () =>
  OperationStatus.cases.Pending.make({
    operationId: makeOperationId(),
    steps: [{ step: { _tag: "Remove", folders: [] }, before: [], after: [], status: "Pending" }],
    before: { installedSkills: [] },
    setup: { changes: { scopes: [], sources: [], memberships: [], versions: [] } },
  });

it.effect(
  "selection writes preserve the rest of the Library and use the existing Collection audit expansion",
  () =>
    Effect.gen(function* () {
      const { home, state, first } = yield* prepared();
      const next = yield* decodeLibraryState({
        ...state,
        enabled: [{ collection: first.collection_id, extension: { kept: [null, true] } }],
        repositories: state.repositories.map((row) => ({ ...row, enabled: [] })),
        device_skill_selection: {
          ...state.device_skill_selection,
          mode: "choose",
          enabled: [{ skill: first.skill_id, extension: { kept: null } }],
        },
      });
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          const revision = yield* writer.revision;
          assert.strictEqual(yield* writer.saveEnabled(next, state, revision), revision + 1);
        }),
      );
      assert.strictEqual(canonicalJson(yield* loadLibrary(home)), canonicalJson(next));
      const audit = yield* readLibraryAudit(home);
      assert.deepStrictEqual(
        audit.flatMap((event) => event.changes),
        diffLibraryState(state, next),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "enabling one Skill writes three rows, needs no unrelated tables, and refuses stale writes",
  () =>
    Effect.gen(function* () {
      const { home, state, first, path } = yield* prepared(false);
      const next = { ...state, enabled: [{ skill: first.skill_id }] };
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DROP TABLE library_sync_base`;
          yield* sql`DROP TABLE library_inventory`;
          yield* sql`DROP TABLE library_assessment_acceptances`;
          yield* sql`DROP TABLE library_installed_skills`;
        }),
      );
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          const revision = yield* writer.revision;
          // Join one connection so total_changes measures only the real owner mutation.
          yield* withLibraryDatabase(
            path,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const [before] = yield* sql<{ count: number }>`SELECT total_changes() AS count`;
              const accepted = yield* writer.saveEnabled(next, state, revision);
              assert.strictEqual(accepted, revision + 1);
              const [after] = yield* sql<{ count: number }>`SELECT total_changes() AS count`;
              assert.strictEqual(after!.count - before!.count, 3); // enabled row, revision, audit
              assert.strictEqual(yield* writer.saveEnabled(next, next, accepted), accepted);
              assert.deepStrictEqual((yield* loadEnabledRows()).enabled, next.enabled);
              assert.strictEqual(
                (yield* Effect.flip(writer.saveEnabled(state, next, revision)))._tag,
                "LibraryChanged",
              );
              assert.strictEqual(
                (yield* Effect.flip(writer.saveEnabled(state, state, accepted)))._tag,
                "LibraryChanged",
              );
            }),
          );
        }),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const refusal of ["none", "setup", "audit"])
  it.effect(
    `selection rows, setup Undo progress, revision and audit share one transaction (refusal=${refusal})`,
    () =>
      Effect.gen(function* () {
        const { home, state, first, path } = yield* prepared();
        const operation = pending();
        yield* writeLibrary(
          home,
          Effect.gen(function* () {
            const writer = yield* LibraryWriter;
            yield* writer.recordOperation(
              operation,
              snapshotOf(yield* inspectLocalLibraryState(home)),
              "setup",
            );
            const beforeOperation = yield* loadOperation(home, operation.operationId);
            const beforeAudit = yield* readLibraryAudit(home);
            const revision = yield* writer.revision;
            if (refusal !== "none")
              yield* withLibraryDatabase(
                path,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  if (refusal === "setup")
                    yield* sql`CREATE TRIGGER refuse_setup_progress BEFORE UPDATE ON library_operations BEGIN SELECT RAISE(ABORT,'setup refusal'); END`;
                  else
                    yield* sql`CREATE TRIGGER refuse_scope_audit BEFORE INSERT ON library_audit_events BEGIN SELECT RAISE(ABORT,'audit refusal'); END`;
                }),
              );
            const save = writer
              .saveEnabled({ ...state, enabled: [{ skill: first.skill_id }] }, state, revision)
              .pipe(Effect.provideService(CurrentSetupOperation, operation.operationId));
            if (refusal === "none") {
              assert.strictEqual(yield* save, revision + 1);
              const saved = Option.getOrUndefined(
                yield* loadOperation(home, operation.operationId),
              );
              if (saved?._tag !== "Pending") return yield* Effect.die("Missing setup");
              assert.strictEqual(saved.setup?.changes.scopes.length, 1);
              const refused = yield* Effect.flip(
                writer
                  .saveOperation({ ...saved, setup: operation.setup }, saved)
                  .pipe(Effect.provideService(CurrentSetupOperation, operation.operationId)),
              );
              assert.strictEqual(refused._tag, "LibraryChanged");
              assert.deepStrictEqual(
                yield* loadOperation(home, operation.operationId),
                Option.some(saved),
              );
              assert.deepStrictEqual(saved.setup?.changes.scopes[0]?.enabled[0]?.after, {
                skill: first.skill_id,
              });
            } else {
              assert.strictEqual((yield* Effect.flip(save))._tag, "LibrarySqlError");
              assert.strictEqual(yield* writer.revision, revision);
              assert.deepStrictEqual(yield* loadLibrary(home), state);
              assert.deepStrictEqual(
                yield* loadOperation(home, operation.operationId),
                beforeOperation,
              );
              assert.deepStrictEqual(yield* readLibraryAudit(home), beforeAudit);
            }
          }),
        );
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("a refused final operation write rolls back its installed rows, revision and audit", () =>
  Effect.gen(function* () {
    const { home, state, path } = yield* prepared();
    const operation = pending();
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        yield* writer.recordOperation(
          operation,
          snapshotOf(yield* inspectLocalLibraryState(home)),
          "setup",
        );
        const recorded = Option.getOrUndefined(yield* loadOperation(home, operation.operationId));
        if (recorded?._tag !== "Pending") return yield* Effect.die("Missing operation");
        const beforeAudit = yield* readLibraryAudit(home);
        const revision = yield* writer.revision;
        yield* withLibraryDatabase(
          path,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE TRIGGER refuse_final_progress BEFORE UPDATE ON library_operations BEGIN SELECT RAISE(ABORT,'operation refusal'); END`;
          }),
        );
        const failure = yield* Effect.flip(
          writer.saveOperation({ ...recorded, preparation: { roots: [], done: true } }, recorded, {
            revision,
            installedSkills: {
              next: state.installed_skills.slice(1),
              base: state.installed_skills,
            },
          }),
        );
        assert.strictEqual(failure._tag, "LibrarySqlError");
        assert.strictEqual(yield* writer.revision, revision);
        assert.deepStrictEqual(yield* loadLibrary(home), state);
        assert.deepStrictEqual(
          yield* loadOperation(home, operation.operationId),
          Option.some(recorded),
        );
        assert.deepStrictEqual(yield* readLibraryAudit(home), beforeAudit);
      }),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "successive selection writes retain a divergent agreed base, including unknown fields",
  () =>
    Effect.gen(function* () {
      const { home, state, first, path } = yield* prepared();
      if (!state.sync_ancestry) return yield* Effect.die("Missing agreed base");
      const agreed = [{ skill: first.skill_id, extension: { receipt: [null, "remote"] } }];
      const before = {
        ...state,
        sync_ancestry: {
          ...state.sync_ancestry,
          base_manifest: { ...state.sync_ancestry.base_manifest, enabled: agreed },
        },
      };
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          yield* writer.save(before, state);
          let revision = yield* writer.revision;
          const collection = { ...before, enabled: [{ collection: first.collection_id }] };
          revision = yield* writer.saveEnabled(collection, before, revision);
          assert.deepStrictEqual((yield* loadLibrary(home)).sync_ancestry, before.sync_ancestry);
          const skill = { ...before, enabled: [{ skill: first.skill_id }] };
          revision = yield* writer.saveEnabled(skill, collection, revision);
          assert.deepStrictEqual((yield* loadLibrary(home)).sync_ancestry, before.sync_ancestry);
          const matching = { ...before, enabled: agreed };
          yield* writer.saveEnabled(matching, skill, revision);
          assert.deepStrictEqual((yield* loadLibrary(home)).sync_ancestry, before.sync_ancestry);
          yield* withLibraryDatabase(
            path,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              assert.deepStrictEqual(
                yield* sql`SELECT * FROM library_sync_base WHERE entity='enabled'`,
                [],
              );
            }),
            true,
          );
        }),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("unavailable device choices remain consent while account selections change", () =>
  Effect.gen(function* () {
    const { home, state, first } = yield* prepared();
    const selection = {
      mode: "choose" as const,
      enabled: [{ collection: makeCollectionId() }, { skill: makeSkillId() }],
    };
    const base = { ...state, device_skill_selection: selection };
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        yield* writer.save(base, state);
        yield* writer.saveEnabled(
          { ...base, enabled: [{ skill: first.skill_id }] },
          base,
          yield* writer.revision,
        );
      }),
    );
    const saved = yield* loadLibrary(home);
    assert.deepStrictEqual(saved.device_skill_selection, selection);
    const installation = deviceInstallationIntent(saved);
    assert.deepStrictEqual(installation.missing, selection.enabled);
    assert.deepStrictEqual(installation.globals[0]?.enabled, []);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const subject of ["skill", "collection"] as const)
  it.effect(`device selection saves unavailable ${subject} as consent`, () =>
    Effect.gen(function* () {
      const { home, state } = yield* prepared();
      const selection = {
        mode: "choose" as const,
        enabled: [
          subject === "skill" ? { skill: makeSkillId() } : { collection: makeCollectionId() },
        ],
      };
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          const revision = yield* writer.revision;
          assert.strictEqual(
            yield* writer.saveEnabled(
              { ...state, device_skill_selection: selection },
              state,
              revision,
            ),
            revision + 1,
          );
        }),
      );
      const saved = yield* loadLibrary(home);
      assert.deepStrictEqual(saved.device_skill_selection, selection);
      assert.deepStrictEqual(deviceInstallationIntent(saved).missing, selection.enabled);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
