import { prepareLibraryDifference } from "../src/library/store/difference.js";
import { join } from "node:path";
import { SqlClient } from "effect/sql";
import { libraryDatabasePath, withLibraryDatabase } from "../src/library/store/database.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Schema } from "effect";
import { emptyLibraryState, LibraryStateDocument } from "../src/library/library-state.js";
import { makeOperationId } from "../src/library/entity-ids.js";
import { recordedLibrary } from "../src/library/store/intent.js";
import { snapshotOf } from "../src/library/snapshot.js";
import { OperationStatus } from "../src/library/store/state-schema.js";
import {
  inspectLocalLibraryState,
  migrateLocalLibraryState,
  LibraryWriter,
  loadLibrary,
  loadOperation,
  loadOperations,
  writeLibrary,
} from "../src/library/store/library-store.js";
import { readLibraryAudit } from "../src/library/audit/audit-log.js";
import { skitLayer } from "../src/platform/layer.js";

const fixture = Effect.fn("Test.operationFixture")(function* (
  kind: "setup" | "apply" | "sync" = "setup",
) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-operation-store-" });
  const state = emptyLibraryState();
  yield* writeLibrary(
    home,
    Effect.gen(function* () {
      yield* (yield* LibraryWriter).save(state, state);
    }),
  );
  const pending = OperationStatus.cases.Pending.make({
    operationId: makeOperationId(),
    steps: [
      {
        step: { _tag: "Remove", folders: [] },
        before: [],
        after: [],
        status: "Pending",
      },
    ],
    before: kind === "setup" ? { installedSkills: [] } : recordedLibrary(state),
    ...(kind === "setup"
      ? { setup: { changes: { scopes: [], sources: [], memberships: [], versions: [] } } }
      : {}),
  });
  return { home, state, pending };
});

for (const kind of ["setup", "apply", "sync"] as const)
  it.effect(`native ${kind} acceptance and settlement do not read unrelated inventory`, () =>
    Effect.gen(function* () {
      const { home, pending, state } = yield* fixture(kind);
      const snapshot = snapshotOf(yield* inspectLocalLibraryState(home));
      const path = libraryDatabasePath(home);
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO library_scan_issues(position,code,path,harness) VALUES(9999,'FUTURE_ISSUE','/unrelated','codex')`;
        }),
      );
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          yield* writer.recordOperation(pending, snapshot, kind);
          const accepted = Option.getOrThrow(yield* loadOperation(home, pending.operationId));
          if (accepted._tag !== "Pending") return yield* Effect.die("Expected Pending operation");
          yield* writer.settleOperation(accepted);
        }),
      );
      const terminal = yield* loadOperation(home, pending.operationId);
      if (kind === "setup") assert.strictEqual(Option.getOrThrow(terminal)._tag, "Done");
      else assert.isTrue(Option.isNone(terminal));
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(
            yield* sql`SELECT code FROM library_scan_issues WHERE position=9999`,
            [{ code: "FUTURE_ISSUE" }],
          );
          yield* sql`DELETE FROM library_scan_issues WHERE position=9999`;
        }),
      );
      assert.deepStrictEqual(yield* loadLibrary(home), state);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect(
  "recording refuses a prospective or mutated snapshot without changing Library state",
  () =>
    Effect.gen(function* () {
      const { home, state, pending } = yield* fixture();
      const snapshot = snapshotOf(yield* inspectLocalLibraryState(home));
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          const prospective = snapshotOf({ present: true, state });
          assert.strictEqual(
            (yield* Effect.flip(writer.recordOperation(pending, prospective, "setup")))._tag,
            "LibraryChanged",
          );
          if (snapshot._tag !== "Present") return yield* Effect.die("Missing saved Library");
          snapshot.state.repositories.push({ root: join(home, "changed-after-read"), enabled: [] });
          assert.strictEqual(
            (yield* Effect.flip(writer.recordOperation(pending, snapshot, "setup")))._tag,
            "LibraryChanged",
          );
        }),
      );
      assert.deepStrictEqual(yield* loadOperations(home), []);
      assert.deepStrictEqual(yield* loadLibrary(home), state);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("rejects stale progress and rolls back its accompanying domain change", () =>
  Effect.gen(function* () {
    const { home, state, pending } = yield* fixture();
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        yield* writer.recordOperation(
          pending,
          snapshotOf(yield* inspectLocalLibraryState(home)),
          "setup",
        );
        const progressed = { ...pending, preparation: { roots: [], done: true } };
        yield* writer.saveOperation(progressed, pending);
        const failure = yield* Effect.flip(
          writer.saveOperation({ ...pending, steps: [] }, pending, {
            base: state,
            next: {
              ...state,
              scanIssues: [{ path: "/stale", harness: "codex", code: "MISSING_ROOT" }],
            },
          }),
        );
        assert.strictEqual(failure._tag, "LibraryChanged");
        assert.deepStrictEqual(yield* loadOperations(home), [progressed]);
        assert.deepStrictEqual(yield* loadLibrary(home), state);
      }),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const settled of ["missing", "Done", "Stopped"])
  it.effect(`settlement refuses a ${settled} record without writing`, () =>
    Effect.gen(function* () {
      const { home, state, pending } = yield* fixture();
      if (settled !== "missing")
        yield* writeLibrary(
          home,
          Effect.gen(function* () {
            const writer = yield* LibraryWriter;
            yield* writer.recordOperation(
              pending,
              snapshotOf(yield* inspectLocalLibraryState(home)),
              "setup",
            );
            yield* writer.settleOperation(
              pending,
              settled === "Stopped"
                ? {
                    _tag: "EvidenceDiffers",
                    step: 0,
                    path: "/changed",
                    expected: { before: Option.none(), after: Option.none() },
                  }
                : undefined,
            );
          }),
        );
      const records = yield* loadOperations(home);
      const events = yield* readLibraryAudit(home);
      const failure = yield* Effect.flip(
        writeLibrary(
          home,
          Effect.gen(function* () {
            yield* (yield* LibraryWriter).settleOperation(pending);
          }),
        ),
      );
      assert.strictEqual(failure._tag, "LibraryChanged");
      assert.deepStrictEqual(yield* loadLibrary(home), state);
      assert.deepStrictEqual(yield* loadOperations(home), records);
      assert.deepStrictEqual(yield* readLibraryAudit(home), events);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect(
  "record-only progress leaves domain freshness unchanged and retains only settled evidence",
  () =>
    Effect.gen(function* () {
      const { home, state, pending } = yield* fixture();
      const before = snapshotOf(yield* inspectLocalLibraryState(home));
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          yield* writer.recordOperation(pending, before, "setup");
          const next = OperationStatus.cases.Pending.make({
            ...pending,
            steps: pending.steps.map((step) => ({ ...step, status: "Done" })),
          });
          yield* writer.saveOperation(next, pending);
          yield* writer.settleOperation(next);
        }),
      );
      assert.strictEqual(
        snapshotOf(yield* inspectLocalLibraryState(home)).revision,
        before.revision,
      );
      assert.deepStrictEqual(yield* loadOperations(home), [
        OperationStatus.cases.Done.make({
          operationId: pending.operationId,
          kind: "setup",
          steps: [{ step: { _tag: "Remove" }, before: [], after: [], status: "Done" }],
          before: pending.before,
          after: pending.before,
          setup: pending.setup,
        }),
      ]);
      const events = yield* readLibraryAudit(home);
      assert.strictEqual(events.length, 1);
      assert.deepStrictEqual(
        events[0]?.changes.map((change) => change.action),
        ["operation-Pending", "operation-Done"],
      );
      // The accepted domain revision still permits an ordinary state save after record progress.
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          yield* (yield* LibraryWriter).save({ ...state, scanIssues: [] }, state);
        }),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const field of ["operations", "historyDelivery"])
  it.effect(`current domain documents reject ${field} as a reserved field`, () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        Schema.decodeEffect(LibraryStateDocument)({ ...emptyLibraryState(), [field]: [] }),
      );
      assert.strictEqual(result._tag, "Failure");
    }),
  );

it.effect("recording a retained operation id is a stale plan and changes nothing", () =>
  Effect.gen(function* () {
    const { home, state, pending } = yield* fixture();
    const base = snapshotOf(yield* inspectLocalLibraryState(home));
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        yield* writer.recordOperation(pending, base, "setup");
        yield* writer.settleOperation(pending);
      }),
    );
    const records = yield* loadOperations(home);
    const events = yield* readLibraryAudit(home);
    const failure = yield* Effect.flip(
      writeLibrary(
        home,
        Effect.gen(function* () {
          yield* (yield* LibraryWriter).recordOperation(pending, base, "setup");
        }),
      ),
    );
    assert.strictEqual(failure._tag, "Library.StalePlan");
    if (failure._tag === "Library.StalePlan")
      assert.strictEqual(failure.reason._tag, "OperationAlreadyRecorded");
    assert.deepStrictEqual(yield* loadOperations(home), records);
    assert.deepStrictEqual(yield* loadLibrary(home), state);
    assert.deepStrictEqual(yield* readLibraryAudit(home), events);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("operation readers do not decode an unrelated corrupt domain document", () =>
  Effect.gen(function* () {
    const { home, state, pending } = yield* fixture();
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
    // The real store cannot write this document: corruption is this test's subject.
    yield* withLibraryDatabase(
      libraryDatabasePath(home),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA ignore_check_constraints=ON`;
        yield* sql`UPDATE library_device SET schema_version=99 WHERE id=1`;
        yield* sql`PRAGMA ignore_check_constraints=OFF`;
      }),
    );
    const failure = yield* Effect.flip(inspectLocalLibraryState(home));
    assert.strictEqual(failure._tag, "InvalidLibraryState");
    assert.deepStrictEqual(yield* loadOperations(home), [pending]);
    assert.deepStrictEqual(yield* loadOperation(home, pending.operationId), Option.some(pending));
    // Startup resumes with the original action id. Its write entry must still stop before acting.
    let acted = false;
    const resumed = yield* Effect.flip(
      writeLibrary(
        home,
        Effect.sync(() => {
          acted = true;
        }),
        { resume: pending.operationId },
      ),
    );
    assert.strictEqual(resumed._tag, "InvalidLibraryState");
    assert.isFalse(acted);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const kind of ["apply", "sync"] as const)
  it.effect(`completed ${kind} deletes its row after retaining its lifecycle audit`, () =>
    Effect.gen(function* () {
      const { home, state, pending } = yield* fixture(kind);
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          yield* writer.recordOperation(
            pending,
            snapshotOf(yield* inspectLocalLibraryState(home)),
            kind,
          );
          yield* writer.settleOperation(pending);
        }),
      );
      assert.deepStrictEqual(yield* loadOperations(home), []);
      assert.deepStrictEqual(
        (yield* readLibraryAudit(home)).flatMap((event) =>
          event.changes.map((change) => change.action),
        ),
        ["operation-Pending", "operation-Done"],
      );
      const stopped = { ...pending, operationId: makeOperationId() };
      const reason = {
        _tag: "EvidenceDiffers",
        step: 0,
        path: "/user/edit",
        expected: { before: Option.none(), after: Option.none() },
      } satisfies import("../src/library/store/state-schema.js").SetupStopReason;
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          yield* writer.recordOperation(
            stopped,
            snapshotOf(yield* inspectLocalLibraryState(home)),
            kind,
          );
          yield* writer.settleOperation(stopped, reason);
        }),
      );
      const retained = (yield* loadOperations(home))[0];
      assert.deepStrictEqual(retained, {
        _tag: "Stopped",
        operationId: stopped.operationId,
        kind,
        before: stopped.before,
        after: recordedLibrary(state),
        reason,
        steps: [{ step: { _tag: "Remove" }, before: [], after: [], status: "Pending" }],
      });
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("released setup imports keep their executable Pending steps and compact intent", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { state, pending } = yield* fixture();
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-dev-operation-" });
    const completed = {
      _tag: "Done",
      operationId: makeOperationId(),
      steps: [{ step: { _tag: "Apply", obsolete: true } }],
    };
    yield* fs.writeFileString(
      join(home, "state.json"),
      JSON.stringify({
        ...state,
        operations: [
          completed,
          {
            operationId: pending.operationId,
            _tag: "Pending",
            steps: pending.steps,
            before: recordedLibrary(state),
          },
        ],
      }),
    );
    yield* migrateLocalLibraryState(home);
    yield* withLibraryDatabase(
      libraryDatabasePath(home),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows =
          yield* sql`SELECT summary FROM library_legacy_operations WHERE operation_id=${completed.operationId}`;
        assert.deepStrictEqual(rows, [{ summary: null }]);
      }),
      true,
    );
    const accepted = (yield* loadOperations(home))[0];
    assert.ok(accepted);
    if (accepted._tag !== "Pending") return assert.fail("Expected imported Pending setup");
    assert.deepStrictEqual(accepted.steps, pending.steps);
    assert.isFalse(Object.hasOwn(accepted.before, "intent"));
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        yield* (yield* LibraryWriter).settleOperation(accepted);
      }),
    );
    assert.deepStrictEqual((yield* loadOperations(home))[0], {
      _tag: "Done",
      operationId: pending.operationId,
      kind: "setup",
      setup: pending.setup,
      steps: [{ step: { _tag: "Remove" }, before: [], after: [], status: "Pending" }],
      before: pending.before,
      after: pending.before,
    });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("new setup keeps a previously Stopped setup Undone and removes its finished Undo", () =>
  Effect.gen(function* () {
    const { home, state, pending } = yield* fixture();
    const target = { ...pending, operationId: makeOperationId() };
    const undo = OperationStatus.cases.Pending.make({
      operationId: makeOperationId(),
      before: recordedLibrary(state),
      steps: [
        {
          step: {
            _tag: "Undo",
            program: {
              operationId: target.operationId,
              backupId: "00000000-0000-4000-8000-000000000001",
              difference: yield* prepareLibraryDifference(state, state, home),
              files: [],
              paths: [],
              sources: [],
              sourceImports: [],
              actions: [],
              preserve: [],
              preserved: true,
            },
          },
          status: "Pending",
          before: [],
          after: [],
        },
      ],
    });
    const latest = { ...pending, operationId: makeOperationId() };
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        const base = snapshotOf(yield* inspectLocalLibraryState(home));
        yield* writer.recordOperation(pending, base, "setup");
        yield* writer.settleOperation(pending);
        yield* writer.recordOperation(target, base, "setup", true);
        yield* writer.settleOperation(target, {
          _tag: "EvidenceDiffers",
          step: 0,
          path: "/kept",
          expected: { before: Option.none(), after: Option.none() },
        });
        yield* writer.recordOperation(undo, base, "undo");
        const step = undo.steps[0]!.step;
        assert.strictEqual(step._tag, "Undo");
        if (step._tag === "Undo")
          yield* writer.saveUndo(step.program, state, state, yield* writer.revision);
        yield* writer.settleOperation(undo);
        yield* writer.recordOperation(latest, base, "setup", true);
        yield* writer.settleOperation(latest);
      }),
    );
    const records = yield* loadOperations(home);
    assert.deepStrictEqual(
      records.map((record) => record.operationId),
      [target.operationId, latest.operationId],
    );
    assert.strictEqual(records[0]?._tag, "Undone");
    assert.isFalse(records.some((record) => record.operationId === undo.operationId));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "fresh Library creation records each absent source and refuses a foreign released-writer lock",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-fresh-database-" });
      const lock = join(home, ".lock");
      yield* fs.writeFileString(lock, "released writer owner");
      const save = writeLibrary(
        home,
        Effect.gen(function* () {
          const state = emptyLibraryState();
          yield* (yield* LibraryWriter).save(state, state);
        }),
      );
      const failure = yield* save.pipe(Effect.flip);
      assert.deepInclude(failure, { _tag: "HomeBusy", path: lock, owner: "released writer owner" });
      assert.isFalse(yield* fs.exists(libraryDatabasePath(home)));
      assert.strictEqual(yield* fs.readFileString(lock), "released writer owner");
      yield* fs.remove(lock);
      yield* save;
      yield* withLibraryDatabase(
        libraryDatabasePath(home),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(
            yield* sql`SELECT source,hash,backup,fenced FROM library_import ORDER BY source`,
            [
              { source: "audit.jsonl", hash: null, backup: null, fenced: 1 },
              { source: "state.json", hash: null, backup: null, fenced: 1 },
            ],
          );
        }),
        true,
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a schema-only database after a killed creation leaves each source unimported until that owner starts",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-fresh-gap-" });
      const path = libraryDatabasePath(home);
      const exit = yield* Effect.exit(
        writeLibrary(
          home,
          Effect.gen(function* () {
            const state = emptyLibraryState();
            yield* (yield* LibraryWriter).save(state, state);
          }),
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            link: (from, to) =>
              Effect.gen(function* () {
                yield* fs.link(from, to);
                if (to === path)
                  return yield* Effect.die("Interrupted after fresh database publication");
              }),
          }),
        ),
      );
      assert.strictEqual(exit._tag, "Failure");
      assert.isTrue(yield* fs.exists(path));
      assert.isFalse(yield* fs.exists(join(home, ".lock")));
      assert.isFalse(yield* fs.exists(join(home, "state.json")));
      yield* migrateLocalLibraryState(home);
      assert.isFalse(yield* fs.exists(join(home, ".lock")));
      assert.deepStrictEqual(yield* inspectLocalLibraryState(home), { present: false });
      assert.isFalse(yield* fs.exists(join(home, "state.json")));
      yield* migrateLocalLibraryState(home, true);
      assert.isAbove(
        JSON.parse(yield* fs.readFileString(join(home, "state.json"))).schemaVersion,
        emptyLibraryState().schemaVersion,
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("corrupt unknown-kind executable payloads cannot fall back to retained summaries", () =>
  Effect.gen(function* () {
    const { home, state, pending } = yield* fixture();
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        yield* writer.recordOperation(
          pending,
          snapshotOf(yield* inspectLocalLibraryState(home)),
          "setup",
        );
        yield* writer.settleOperation(pending);
      }),
    );
    const corrupt = JSON.stringify({
      _tag: "Done",
      setup: pending.setup,
      operationId: pending.operationId,
      before: pending.before,
      after: recordedLibrary(state),
      steps: [{ step: { _tag: "Remove" }, before: [], after: [], status: "Done" }],
    });
    // A valid store cannot produce an unknown-kind full record with its required folders missing.
    yield* withLibraryDatabase(
      libraryDatabasePath(home),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE library_operations SET kind = NULL, document = ${corrupt}`;
      }),
    );
    assert.strictEqual((yield* loadOperations(home).pipe(Effect.flip))._tag, "InvalidLibraryState");
    yield* withLibraryDatabase(
      libraryDatabasePath(home),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(yield* sql`SELECT document FROM library_operations`, [
          { document: corrupt },
        ]);
      }),
      true,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
