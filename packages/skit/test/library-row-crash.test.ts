import { inspectLocalLibraryState } from "../src/library/store/state-file.js";
import { prepareLibraryDifference } from "../src/library/store/difference.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { SqlClient } from "effect/sql";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { skitLayer } from "../src/platform/layer.js";
import { declaredFixture as valuesFixture } from "./helpers/library-values.js";
import {
  emptyLibraryState,
  decodeLibraryState,
  CURRENT_LIBRARY_STATE_VERSION,
  libraryStateRevision,
  type LibraryState,
} from "../src/library/library-state.js";
import { makeOperationId } from "../src/library/entity-ids.js";
import { recordedLibrary } from "../src/library/store/intent.js";
import { OperationStatus } from "../src/library/store/state-schema.js";
import { recordOperation, saveOperation } from "../src/library/store/operations.js";
import {
  migrateLocalLibraryState,
  readDatabaseState,
  saveLibraryState,
} from "../src/library/store/state-file.js";
import { libraryDatabasePath, withLibraryDatabase } from "../src/library/store/database.js";
import { snapshotOf } from "../src/library/snapshot.js";
import { canonicalJson } from "../src/shared/json.js";
import { LibraryAuditEvent } from "../src/library/audit/contracts.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// A stale dist must fail before any subprocess runs. Check the whole core, including
// transitive imports, rather than just the store entrypoints these tests call.
const fixture = Effect.gen(function* () {
  yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directories = [join(packageRoot, "src")];
    for (const directory of directories) {
      for (const name of yield* fs.readDirectory(directory)) {
        const source = join(directory, name);
        const info = yield* fs.stat(source);
        if (info.type === "Directory") directories.push(source);
        else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
          const relative = source.slice(join(packageRoot, "src").length + 1);
          const built = join(packageRoot, "dist", relative.replace(/\.ts$/u, ".js"));
          assert.isTrue(
            yield* fs.exists(built),
            `Missing compiled core: ${relative}. Run pnpm build.`,
          );
          const emitted = yield* fs.stat(built);
          assert.isTrue(
            Option.isSome(info.mtime) && Option.isSome(emitted.mtime),
            "Build freshness needs file timestamps",
          );
          if (Option.isSome(info.mtime) && Option.isSome(emitted.mtime))
            assert.isAtLeast(
              emitted.mtime.value.getTime(),
              info.mtime.value.getTime(),
              `Stale compiled core: ${relative}. Run pnpm build.`,
            );
        }
      }
    }
  });
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "skit-revision-kill-" });
  const home = join(directory, "home");
  const control = join(directory, "control");
  const { state } = yield* valuesFixture;
  const skill = state.skills[0];
  assert.ok(skill);
  const nextState: LibraryState = { ...state, enabled: [{ skill: skill.skill_id }] };
  const operation = OperationStatus.cases.Pending.make({
    operationId: makeOperationId(),
    before: recordedLibrary(state),
    steps: [
      {
        step: {
          _tag: "Undo",
          program: {
            operationId: "fixture-prior-operation",
            backupId: "b56f90ec-d27f-41cf-805f-6234fe1c2810",
            difference: yield* prepareLibraryDifference(state, nextState, home),
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
  });
  const nextOperation = OperationStatus.cases.Pending.make({
    ...operation,
    steps: operation.steps.map((step) => ({ ...step, status: "Done" })),
  });
  const action = {
    eventId: makeOperationId(),
    occurredAt: "2026-11-16T00:00:00.000Z",
    workflow: "test-kill",
  };
  const initialAction = { ...action, eventId: makeOperationId(), workflow: "test-seed" };
  return {
    fs,
    directory,
    home,
    control,
    state,
    nextState,
    operation,
    nextOperation,
    action,
    initialAction,
  };
});
type Fixture = Effect.Success<typeof fixture>;

const seedModern = (f: Fixture, home: string) =>
  Effect.gen(function* () {
    yield* saveLibraryState(home, f.state, emptyLibraryState(), f.initialAction);
    yield* recordOperation(
      home,
      f.operation,
      snapshotOf(yield* inspectLocalLibraryState(home)),
      "undo",
      f.action,
    );
  });
const snapshot = (home: string) =>
  withLibraryDatabase(
    libraryDatabasePath(home),
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const stored = yield* readDatabaseState(libraryDatabasePath(home));
          return {
            state: stored.state ?? null,
            publicHash: stored.state ? libraryStateRevision(stored.state) : null,
            operations:
              yield* sql`SELECT position, operation_id, kind, document FROM library_operations ORDER BY position`,
            audit:
              yield* sql`SELECT sequence, event_id, document, operation_ids FROM library_audit_events ORDER BY sequence`,
          };
        }),
      );
    }),
    true,
  );

const child = Effect.fn("Test.rowProcess")(function* (
  f: Fixture,
  home: string,
  mode: "save" | "import" | "read",
  point: string,
) {
  const input = join(f.directory, `input-${mode}-${point}.json`);
  yield* f.fs.writeFileString(input, JSON.stringify({ ...f, fs: undefined, home, mode, point }));
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const process = yield* spawner.spawn(
    ChildProcess.make(
      globalThis.process.execPath,
      [join(packageRoot, "test/fixtures/library-row-process.ts"), input],
      { cwd: packageRoot, stdout: "pipe", stderr: "inherit" },
    ),
  );
  const lines = yield* process.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.take(1),
    Stream.runCollect,
  );
  assert.strictEqual(lines.length, 1, "Process exited without its structured protocol response");
  const message = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))(
    lines[0] ?? "",
  );
  if (mode === "read") {
    assert.strictEqual(message.kind, "snapshot");
    assert.strictEqual(yield* process.exitCode, 0);
    return message.snapshot;
  }
  assert.deepStrictEqual(message, { kind: "paused", point });
  assert.isTrue(yield* process.isRunning);
  yield* process.kill({ killSignal: "SIGKILL" });
  const exit = yield* Effect.result(process.exitCode);
  assert.strictEqual(exit._tag, "Failure");
  if (exit._tag === "Failure") assert.include(String(exit.failure.cause), "SIGKILL");
  return null;
});

for (const point of ["before-rows", "after-rows", "after-commit"])
  it.effect("SIGKILL save " + point + " leaves state, program and audit together", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* seedModern(f, f.home);
      yield* seedModern(f, f.control);
      const old = yield* snapshot(f.home);
      yield* saveOperation(f.control, f.nextOperation, f.operation, f.action, {
        base: f.state,
        next: f.nextState,
      });
      const next = yield* snapshot(f.control);
      assert.notStrictEqual(old.publicHash, next.publicHash);
      assert.notStrictEqual(canonicalJson(old.operations), canonicalJson(next.operations));
      assert.notStrictEqual(canonicalJson(old.audit), canonicalJson(next.audit));
      yield* child(f, f.home, "save", point);
      assert.strictEqual(
        canonicalJson(yield* child(f, f.home, "read", "none")),
        canonicalJson(point === "after-commit" ? next : old),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

const seedReleased = (f: Fixture, home: string) =>
  Effect.gen(function* () {
    yield* f.fs.makeDirectory(home, { recursive: true });
    const legacy = {
      schemaVersion: 9,
      unmanaged: [
        { harness: "codex", path: "/skills/review", observedHash: "sha256:" + "a".repeat(64) },
      ],
      collections: [],
      skills: [],
      retained_copies: [],
      acquisitions: [],
      global_bindings: [],
      local_bindings: [],
      projections: [],
    };
    const original = JSON.stringify(legacy);
    const event = yield* LibraryAuditEvent.makeEffect({
      ...f.action,
      schemaVersion: 1,
      type: "library.imported",
      changes: [],
    });
    const audit = JSON.stringify(event) + "\n";
    yield* f.fs.writeFileString(join(home, "state.json"), original);
    yield* f.fs.writeFileString(join(home, "audit.jsonl"), audit);
    return { original, audit, legacy };
  });

for (const point of ["before-link", "after-link"])
  it.effect("SIGKILL released import " + point + " restarts without losing sources", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const sources = yield* seedReleased(f, f.home);
      yield* seedReleased(f, f.control);
      yield* migrateLocalLibraryState(f.control);
      const expected = yield* snapshot(f.control);
      const fromSource = yield* decodeLibraryState({
        ...emptyLibraryState(),
        unmanaged: sources.legacy.unmanaged.map(({ observedHash, ...entry }) => ({
          ...entry,
          currentHash: observedHash,
        })),
      });
      assert.strictEqual(canonicalJson(expected.state), canonicalJson(fromSource));
      assert.strictEqual(expected.publicHash, libraryStateRevision(fromSource));
      yield* child(f, f.home, "import", point);
      assert.strictEqual(yield* f.fs.exists(libraryDatabasePath(f.home)), point === "after-link");
      assert.strictEqual(yield* f.fs.readFileString(join(f.home, "state.json")), sources.original);
      assert.strictEqual(yield* f.fs.readFileString(join(f.home, "audit.jsonl")), sources.audit);
      assert.strictEqual(
        canonicalJson(yield* child(f, f.home, "read", "none")),
        canonicalJson(expected),
      );
      assert.strictEqual(
        yield* f.fs.readFileString(join(f.home, "state.json")),
        JSON.stringify({ schemaVersion: CURRENT_LIBRARY_STATE_VERSION + 1 }, null, 2) + "\n",
      );
      assert.strictEqual(yield* f.fs.readFileString(join(f.home, "audit.jsonl")), sources.audit);
      assert.strictEqual(
        yield* f.fs.readFileString(join(f.home, "audit.jsonl.backup-database")),
        sources.audit,
      );
      yield* withLibraryDatabase(
        libraryDatabasePath(f.home),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(
            yield* sql`SELECT fenced FROM library_import WHERE source='state.json'`,
            [{ fenced: 1 }],
          );
        }),
        true,
      );
      assert.strictEqual(
        yield* f.fs.readFileString(join(f.home, "state.json.v9.backup-database")),
        sources.original,
      );
      assert.isFalse(yield* f.fs.exists(join(f.home, ".lock")));
      assert.strictEqual(
        canonicalJson(yield* child(f, f.home, "read", "none")),
        canonicalJson(expected),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
