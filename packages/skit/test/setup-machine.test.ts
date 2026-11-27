import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { SqlClient } from "effect/sql";
import * as Library from "../src/library/library.js";
import * as MachineSettings from "../src/library/machine-settings.js";
import { prepareSetupUndo } from "../src/library/setup/undo.js";
import { withDatabaseTransaction } from "../src/library/database.js";
import { loadLibrary, loadOperations } from "../src/library/store/library-store.js";
import { readLibraryAudit } from "../src/library/audit/audit-log.js";
import { skitLayer } from "../src/platform/layer.js";
import { testRoots } from "./helpers/library-store.js";

it.effect(
  "setup owns discovery evidence and Undo atomically marks that setup Undone, preserving later settings",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-setup-machine-" });
      const before = yield* MachineSettings.updateDiscovery(home, { discoveryRoots: ["/before"] });
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const setup = yield* library.setup([], {
          base: yield* library.read,
          machineChoices: {
            discoveryRoots: ["/after"],
            repositories: [{ path: "/after/repo", status: "watched" }],
            displayName: "Renamed",
          },
        });
        assert.strictEqual(setup._tag, "Done");
        const record = (yield* loadOperations(home)).find(
          (row) => row.operationId === setup.operationId,
        );
        assert.deepStrictEqual(record?.setup?.discovery, {
          before: { discoveryRoots: ["/before"], machineId: before.machineId },
          expectedAfter: { discoveryRoots: ["/after"], machineId: before.machineId },
        });
        assert.isFalse(Object.hasOwn(record!.before, "intent"));
        const preview = yield* prepareSetupUndo(setup.operationId);
        assert.isTrue(preview.summary.settingsChanged);
        assert.strictEqual((yield* preview.apply()).status, "undone");
        const restored = yield* MachineSettings.read(home);
        assert.deepStrictEqual(restored.discoveryRoots, ["/before"]);
        assert.strictEqual(restored.machineId, before.machineId);
        assert.strictEqual(restored.displayName, "Renamed");
        assert.deepStrictEqual(restored.repositories, [{ path: "/after/repo", status: "watched" }]);
        const records = yield* loadOperations(home);
        assert.strictEqual(
          records.find((row) => row.operationId === setup.operationId)?._tag,
          "Undone",
        );
        assert.isFalse(records.some((row) => row.steps.some(({ step }) => step._tag === "Undo")));
        assert.isTrue(
          (yield* readLibraryAudit(home)).some((event) =>
            event.changes.some((change) => change.action === "operation-Undone"),
          ),
        );
        yield* MachineSettings.updateDiscovery(home, {
          discoveryRoots: ["/after"],
          repositories: [{ path: "/independent", status: "watched" }],
        });
        const later = yield* MachineSettings.read(home);
        const repeated = yield* prepareSetupUndo(setup.operationId);
        assert.strictEqual(repeated.summary.status, "already-undone");
        assert.strictEqual((yield* repeated.apply()).status, "already-undone");
        assert.deepStrictEqual(yield* MachineSettings.read(home), later);
      }).pipe(Effect.provide(Library.layer({ home, roots: testRoots(home) })));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("Undo refuses changed roots and stale or forged reviews before saving either owner", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-setup-machine-stale-" });
    yield* MachineSettings.updateDiscovery(home, { discoveryRoots: ["/before"] });
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const setup = yield* library.setup([], {
        base: yield* library.read,
        machineChoices: { discoveryRoots: ["/after"] },
      });
      const plan = yield* library.plan(
        { _tag: "Undo", operationId: setup.operationId },
        { base: yield* library.read },
      );
      const state = yield* loadLibrary(home);
      const machine = yield* MachineSettings.read(home);
      const forged = {
        ...plan,
        change: { ...plan.change, intentChanged: !plan.change.intentChanged },
      };
      assert.strictEqual(
        (yield* Effect.flip(library.apply({ _tag: "Apply", plan: forged })))._tag,
        "Library.StalePlan",
      );
      assert.deepStrictEqual(yield* loadLibrary(home), state);
      assert.deepStrictEqual(yield* MachineSettings.read(home), machine);
      yield* MachineSettings.setRepositoryDecision(home, "/later", "watched");
      assert.strictEqual(
        (yield* Effect.flip(library.apply({ _tag: "Apply", plan })))._tag,
        "Library.StalePlan",
      );
      yield* MachineSettings.updateDiscovery(home, { discoveryRoots: ["/independent"] });
      const changed = yield* prepareSetupUndo(setup.operationId);
      assert.strictEqual(changed.summary.status, "conflicted");
      assert.deepStrictEqual(changed.summary.conflicts, [{ _tag: "DiscoveryFoldersChanged" }]);
      assert.strictEqual((yield* Effect.flip(changed.apply()))._tag, "RecoveryInvalid");
      assert.deepStrictEqual((yield* MachineSettings.read(home)).discoveryRoots, ["/independent"]);
      yield* library.setup([], { base: yield* library.read });
      assert.strictEqual(
        (yield* Effect.flip(
          library.plan(
            { _tag: "Undo", operationId: setup.operationId },
            { base: yield* library.read },
          ),
        ))._tag,
        "RecoveryInvalid",
      );
    }).pipe(Effect.provide(Library.layer({ home, roots: testRoots(home) })));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a failed final Undo transaction changes neither Library nor settings nor the target completion",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-setup-machine-rollback-" });
      yield* MachineSettings.updateDiscovery(home, { discoveryRoots: ["/before"] });
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const setup = yield* library.setup([], {
          base: yield* library.read,
          machineChoices: { discoveryRoots: ["/after"] },
        });
        const state = yield* loadLibrary(home),
          machine = yield* MachineSettings.read(home);
        yield* withDatabaseTransaction(
          home,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE TRIGGER fail_undo_completion BEFORE UPDATE ON library_operations WHEN json_extract(NEW.document,'$._tag')='Undone' BEGIN SELECT RAISE(ABORT,'injected failure'); END`;
          }),
        );
        const review = yield* prepareSetupUndo(setup.operationId);
        assert.strictEqual((yield* Effect.flip(review.apply()))._tag, "RecoveryInvalid");
        assert.deepStrictEqual(yield* loadLibrary(home), state);
        assert.deepStrictEqual(yield* MachineSettings.read(home), machine);
        assert.strictEqual(
          (yield* loadOperations(home)).find((row) => row.operationId === setup.operationId)?._tag,
          "Done",
        );
        yield* withDatabaseTransaction(
          home,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`DROP TRIGGER fail_undo_completion`;
          }),
        );
        const retry = yield* prepareSetupUndo(setup.operationId);
        assert.strictEqual((yield* retry.apply()).status, "undone");
        assert.deepStrictEqual((yield* MachineSettings.read(home)).discoveryRoots, ["/before"]);
        assert.isFalse(
          (yield* loadOperations(home)).some((row) =>
            row.steps.some(({ step }) => step._tag === "Undo"),
          ),
        );
        assert.strictEqual(
          (yield* loadOperations(home)).find((row) => row.operationId === setup.operationId)?._tag,
          "Undone",
        );
      }).pipe(Effect.provide(Library.layer({ home, roots: testRoots(home) })));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
