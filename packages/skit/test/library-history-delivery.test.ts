import { inspectLocalLibraryState } from "../src/library/store/state-file.js";
import { snapshotOf } from "../src/library/snapshot.js";
import { assert, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Option } from "effect";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { libraryDatabasePath, withLibraryDatabase } from "../src/library/database.js";
import {
  loadLibrary,
  loadOperations,
  writeLibrary,
  LibraryWriter,
} from "../src/library/store/library-store.js";
import { libraryHistoryAction } from "../src/library/store/state-file.js";
import { readLibraryAudit } from "../src/library/audit/audit-log.js";
import { makeOperationId } from "../src/library/entity-ids.js";
import { OperationStatus } from "../src/library/store/state-schema.js";
import { recordedLibrary } from "../src/library/store/intent.js";
import { skitLayer } from "../src/platform/layer.js";
import { lockFile } from "../src/platform/file-lock.js";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "skit-history-transaction-" }),
  );
  const home = join(root, "home");
  const source = join(root, "source");
  const skills = join(root, "skills");
  yield* fs.makeDirectory(source);
  yield* fs.makeDirectory(skills);
  yield* fs.writeFileString(
    join(source, "SKILL.md"),
    "---\nname: review\ndescription: review\n---\nOriginal\n",
  );
  const request = yield* localImportRequest(source, "2026-11-05T00:00:00.000Z");
  if (Option.isNone(request)) return yield* Effect.die("Missing fixture source");
  const path = libraryDatabasePath(home);
  const layer = Library.layer({
    home,
    roots: { home: root, configHome: root, overrides: { codex: [skills] } },
  });
  return { fs, home, path, layer, request: request.value };
});

it.effect("opens a settled Library without its home lock and keeps passive reads unchanged", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const owner = yield* Library.Service;
      yield* owner.import.collection(f.request);
    }).pipe(Effect.provide(f.layer));
    const state = yield* loadLibrary(f.home);
    const events = yield* readLibraryAudit(f.home);
    yield* lockFile(join(f.home, "lock.sqlite"));
    yield* Effect.gen(function* () {
      const owner = yield* Library.Service;
      const snapshot = yield* owner.read;
      if (snapshot._tag !== "Present") return yield* Effect.die("Missing saved state");
      assert.deepStrictEqual(snapshot.state, state);
      assert.deepStrictEqual((yield* owner.history).events, events);
    }).pipe(Effect.provide(f.layer));
    assert.strictEqual((yield* Effect.flip(writeLibrary(f.home, Effect.void)))._tag, "HomeBusy");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("each accepted save commits the same cumulative event before the writer ends", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const owner = yield* Library.Service;
      yield* writeLibrary(
        f.home,
        Effect.gen(function* () {
          yield* owner.import.collection(f.request);
          const first = yield* readLibraryAudit(f.home);
          assert.strictEqual(first.length, 1);
          const state = yield* loadLibrary(f.home);
          yield* (yield* LibraryWriter).save(
            { ...state, enabled: [{ skill: state.skills[0]!.skill_id }] },
            state,
          );
          const second = yield* readLibraryAudit(f.home);
          assert.strictEqual(second.length, 1);
          assert.strictEqual(second[0]?.eventId, first[0]?.eventId);
          assert.deepStrictEqual(
            second[0]?.changes.slice(0, first[0]!.changes.length),
            first[0]?.changes,
          );
          assert.strictEqual(second[0]?.changes.at(-1)?.action, "enabled");
          return yield* Effect.fail("failed after two accepted saves");
        }),
      ).pipe(Effect.flip);
    }).pipe(Effect.provide(f.layer));
    assert.strictEqual((yield* loadLibrary(f.home)).enabled.length, 1);
    assert.strictEqual((yield* readLibraryAudit(f.home)).length, 1);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "resume keeps one action identity and gates its event until every operation settles",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        yield* (yield* Library.Service).import.collection(f.request);
      }).pipe(Effect.provide(f.layer));
      const state = yield* loadLibrary(f.home);
      const pending = OperationStatus.cases.Pending.make({
        operationId: makeOperationId(),
        steps: [],
        before: recordedLibrary(state),
      });
      const other = { ...pending, operationId: makeOperationId() };
      yield* writeLibrary(
        f.home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          const base = snapshotOf(yield* inspectLocalLibraryState(f.home));
          yield* writer.recordOperation(pending, base, "apply");
          yield* writer.recordOperation(other, base, "sync");
        }),
      ).pipe(Effect.annotateLogs({ "skit.library.workflow": "test-action" }));
      const action = yield* libraryHistoryAction(f.home, "startup", pending.operationId);
      assert.strictEqual(action.workflow, "test-action");
      assert.deepStrictEqual(
        yield* libraryHistoryAction(f.home, "other", other.operationId),
        action,
      );
      assert.strictEqual((yield* readLibraryAudit(f.home)).length, 1);
      yield* writeLibrary(
        f.home,
        Effect.gen(function* () {
          yield* (yield* LibraryWriter).settleOperation(pending);
        }),
        { resume: pending.operationId },
      );
      assert.strictEqual((yield* readLibraryAudit(f.home)).length, 1);
      assert.deepStrictEqual(
        (yield* loadOperations(f.home)).map((row) => row.operationId),
        [other.operationId],
      );
      yield* writeLibrary(
        f.home,
        Effect.gen(function* () {
          yield* (yield* LibraryWriter).settleOperation(other);
        }),
        { resume: other.operationId },
      );
      const events = yield* readLibraryAudit(f.home);
      assert.strictEqual(events.length, 2);
      assert.strictEqual(events[1]?.eventId, action.eventId);
      assert.strictEqual(events[1]?.occurredAt, action.occurredAt);
      assert.strictEqual(events[1]?.workflow, action.workflow);
      assert.deepStrictEqual(
        events[1]?.changes.map((change) => change.action),
        ["operation-Pending", "operation-Pending", "operation-Done", "operation-Done"],
      );
      assert.deepStrictEqual(yield* loadOperations(f.home), []);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a failed event update rolls back settlement and leaves the original action resumable",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        yield* (yield* Library.Service).import.collection(f.request);
      }).pipe(Effect.provide(f.layer));
      const state = yield* loadLibrary(f.home);
      const pending = OperationStatus.cases.Pending.make({
        operationId: makeOperationId(),
        steps: [],
        before: recordedLibrary(state),
      });
      yield* writeLibrary(
        f.home,
        Effect.gen(function* () {
          yield* (yield* LibraryWriter).recordOperation(
            pending,
            snapshotOf(yield* inspectLocalLibraryState(f.home)),
            "apply",
          );
        }),
      );
      const action = yield* libraryHistoryAction(f.home, "resume", pending.operationId);
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TRIGGER audit_failure BEFORE UPDATE ON library_audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`;
        }),
      );
      const failed = yield* writeLibrary(
        f.home,
        Effect.gen(function* () {
          yield* (yield* LibraryWriter).settleOperation(pending);
        }),
        { resume: pending.operationId },
      ).pipe(Effect.flip);
      assert.strictEqual(failed._tag, "LibrarySqlError");
      assert.deepStrictEqual(yield* loadOperations(f.home), [pending]);
      assert.strictEqual((yield* readLibraryAudit(f.home)).length, 1);
      assert.deepStrictEqual(
        yield* libraryHistoryAction(f.home, "resume", pending.operationId),
        action,
      );
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          yield* (yield* SqlClient.SqlClient)`DROP TRIGGER audit_failure`;
        }),
      );
      yield* writeLibrary(
        f.home,
        Effect.gen(function* () {
          yield* (yield* LibraryWriter).settleOperation(pending);
        }),
        { resume: pending.operationId },
      );
      assert.deepStrictEqual(yield* loadOperations(f.home), []);
      assert.strictEqual((yield* readLibraryAudit(f.home))[1]?.eventId, action.eventId);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("interruption after committed state needs no delivery finalizer or startup retry", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const committed = yield* Deferred.make<void>();
    const owner = yield* Library.Service.pipe(Effect.provide(f.layer));
    const writing = yield* writeLibrary(
      f.home,
      Effect.gen(function* () {
        yield* owner.import.collection(f.request);
        yield* Deferred.succeed(committed, undefined);
        return yield* Effect.never;
      }),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(committed);
    assert.strictEqual((yield* readLibraryAudit(f.home)).length, 1);
    yield* Fiber.interrupt(writing);
    const exit = yield* Fiber.await(writing);
    assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
    yield* writeLibrary(f.home, Effect.void);
    assert.strictEqual((yield* loadLibrary(f.home)).collections.length, 1);
    assert.strictEqual((yield* readLibraryAudit(f.home)).length, 1);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a normal owner mutation checks its own audit identity without reading unrelated corrupt history",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const owner = yield* Library.Service;
        yield* owner.import.collection(f.request);
        const original = (yield* readLibraryAudit(f.home))[0];
        if (!original) return assert.fail("Missing imported audit");
        yield* withLibraryDatabase(
          f.path,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            // Inject corruption below the schema boundary to exercise the reader.
            yield* sql`PRAGMA ignore_check_constraints=ON`;
            yield* sql`UPDATE library_audit_events SET document='{' WHERE event_id=${original.eventId}`;
            yield* sql`PRAGMA ignore_check_constraints=OFF`;
          }),
        );
        const result = yield* owner.setup([], { base: yield* owner.read });
        assert.strictEqual(result._tag, "Done");
        assert.strictEqual(
          (yield* Effect.flip(readLibraryAudit(f.home)))._tag,
          "LibraryAuditInvalid",
        );
        yield* withLibraryDatabase(
          f.path,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.deepStrictEqual(
              yield* sql`SELECT document FROM library_audit_events WHERE event_id=${original.eventId}`,
              [{ document: "{" }],
            );
            const rows =
              yield* sql`SELECT document FROM library_audit_events WHERE event_id<>${original.eventId}`;
            assert.strictEqual(rows.length, 1);
          }),
          true,
        );
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
