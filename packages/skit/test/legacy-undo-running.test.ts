import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { makeOperationId } from "../src/library/entity-ids.js";
import { recordedLibrary } from "../src/library/store/intent.js";
import { migrateLocalLibraryState } from "../src/library/store/state-file.js";
import { loadLibrary, loadOperations } from "../src/library/store/library-store.js";
import { libraryDatabasePath, withLibraryDatabase } from "../src/library/store/database.js";
import { prepareLibrarySide } from "../src/library/store/difference.js";
import { recover } from "../src/library/internal/setup/run.js";
import { skitLayer } from "../src/platform/layer.js";
import { libraryLayer } from "./helpers/library-store.js";
import { declaredFixture as fixture } from "./helpers/library-values.js";

for (const status of ["Pending", "Stopped"] as const)
  it.effect(
    `a legacy ${status} Undo imports without losing its executable inverse or original evidence`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-running-undo-" });
        const { state } = yield* fixture;
        const skill = state.skills[0];
        if (!skill) return assert.fail("Missing fixture skill");
        const disabled = { ...state, installed_skills: [], enabled: [] };
        const enabled = { ...disabled, enabled: [{ skill: skill.skill_id }] };
        const targetId = makeOperationId(),
          attemptId = makeOperationId();
        const reason = { _tag: "LibraryChanged", step: 0, revision: "legacy-reviewed" };
        const target = {
          _tag: "Stopped",
          operationId: targetId,
          steps: [],
          reason,
          before: recordedLibrary(disabled),
          after: recordedLibrary(enabled),
        };
        const program = {
          operationId: targetId,
          backupId: "87362930-1a1f-4c45-88f0-02727023ca67",
          before: enabled,
          after: disabled,
          files: [],
          paths: [],
          sources: [],
          sourceImports: [],
          actions: [],
          preserve: [],
          preserved: false,
          extension: { original: [false, null, false] },
        };
        yield* fs.makeDirectory(join(home, "removed", program.backupId), { recursive: true });
        const attempt = {
          _tag: status,
          operationId: attemptId,
          before: recordedLibrary(enabled),
          ...(status === "Stopped" ? { after: recordedLibrary(enabled), reason } : {}),
          steps: [{ step: { _tag: "Undo", program }, before: [], after: [], status: "Pending" }],
          extension: { retained: true },
        };
        const source =
          JSON.stringify({ ...enabled, operations: [target, attempt] }, null, 2) + "\n";
        yield* fs.writeFileString(join(home, "state.json"), source);
        yield* migrateLocalLibraryState(home);
        const imported = yield* loadOperations(home);
        assert.deepStrictEqual(
          imported.map((row) => [row.operationId, row._tag]),
          [
            [targetId, "Stopped"],
            [attemptId, status],
          ],
        );
        const step = imported[1]?.steps[0]?.step;
        if (step?._tag !== "Undo" || !("difference" in step.program))
          return assert.fail("Missing imported Undo program");
        assert.strictEqual(step.program.backupId, program.backupId);
        assert.deepStrictEqual(
          yield* prepareLibrarySide(step.program.difference, enabled, "before", home),
          enabled,
        );
        assert.deepStrictEqual(
          yield* prepareLibrarySide(step.program.difference, enabled, "after", home),
          disabled,
        );
        yield* withLibraryDatabase(
          libraryDatabasePath(home),
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.deepStrictEqual(
              yield* sql`SELECT kind FROM library_operations WHERE operation_id=${attemptId}`,
              [{ kind: "undo" }],
            );
            const rows = yield* sql<{
              operation_id: string;
            }>`SELECT operation_id FROM library_legacy_operations ORDER BY position`;
            assert.deepStrictEqual(
              rows.map((row) => row.operation_id),
              [target.operationId, attempt.operationId],
            );
          }),
          true,
        );
        yield* migrateLocalLibraryState(home);
        assert.deepStrictEqual(yield* loadOperations(home), imported);
        assert.strictEqual(
          yield* fs.readFileString(
            join(home, `state.json.v${state.schemaVersion}.backup-database`),
          ),
          source,
        );
        yield* Effect.gen(function* () {
          const owner = yield* Library.Service;
          assert.strictEqual((yield* owner.read)._tag, "Present");
          if (status === "Pending") {
            // Building the fresh owner already resumed the imported Pending inverse.
            assert.deepStrictEqual((yield* loadLibrary(home)).enabled, []);
            assert.deepStrictEqual(
              (yield* loadOperations(home)).map((row) => [row.operationId, row._tag]),
              [[targetId, "Undone"]],
            );
            const result = yield* recover(home);
            assert.deepStrictEqual(result.stopped, []);
            assert.deepStrictEqual(result.finished, []);
          } else {
            const plan = yield* owner.plan(
              { _tag: "Undo", operationId: targetId },
              { base: yield* owner.read },
            );
            assert.deepStrictEqual(plan.change.conflicts, []);
            yield* owner.apply({ _tag: "Apply", plan });
          }
        }).pipe(Effect.provide(libraryLayer(home)));
        assert.deepStrictEqual((yield* loadLibrary(home)).enabled, []);
        assert.deepStrictEqual(
          (yield* loadOperations(home)).map((row) => [row.operationId, row._tag]),
          [[targetId, "Undone"]],
        );
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
