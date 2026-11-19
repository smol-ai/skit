import { NodeRuntime } from "@effect/platform-node";
// Test protocol and pause points only. Every Library function below comes from the compiled core.
import { systemError } from "effect/PlatformError";
import { Clock, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { SqlClient, Statement } from "effect/sql";
import { skitLayer } from "../../dist/platform/layer.js";
import {
  libraryManifestFromLocalState,
  libraryStateRevision,
  LibraryStateDocument,
} from "../../dist/library/library-state.js";
import {
  OperationStatus,
  type FolderEvidence,
  type LinkEvidence,
} from "../../dist/library/store/state-schema.js";
import { HistoryAction } from "../../dist/library/store/history-action.js";
import { withLibraryDatabase, libraryDatabasePath } from "../../dist/library/store/database.js";
import {
  migrateLocalLibraryState,
  readDatabaseState,
} from "../../dist/library/store/state-file.js";
import { saveOperation } from "../../dist/library/store/operations.js";

import { Digest } from "effect/crypto";
import { join } from "node:path";
import * as Library from "../../dist/library/library.js";
import { localImportRequest } from "../../dist/library/setup/local-import.js";
import { loadLibrary, loadOperations } from "../../dist/library/store/library-store.js";
import { prepareLibrarySide } from "../../dist/library/store/difference.js";
import { readPathEvidence } from "../../dist/library/folder-evidence.js";
import { canonicalJson } from "../../dist/shared/json.js";

const applySyncUndoProcess = (root: string, mode: string, run: string) => {
  const home = join(root, "library");
  const source = join(root, "source");
  const skills = join(root, "skills");
  const installed = join(skills, "review");
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const digest = yield* Digest.Digest;
    const clock = yield* Clock.Clock;
    const fixedClock: Clock.Clock = {
      currentTimeNanos: clock.currentTimeNanos,
      currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
      monotonicTimeNanos: clock.monotonicTimeNanos,
      monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
      sleep: (duration) => clock.sleep(duration),
      currentTimeMillis: Effect.succeed(1_800_000_000_000),
      currentTimeMillisUnsafe: () => 1_800_000_000_000,
    };
    const layer = Library.layer({
      home,
      roots: { home: root, configHome: root, overrides: { codex: [skills] } },
    }).pipe(Layer.provide(Layer.succeed(Clock.Clock, fixedClock)));
    if (mode === "init") {
      yield* fs.makeDirectory(source, { recursive: true });
      yield* fs.makeDirectory(skills);
      yield* fs.writeFileString(
        join(source, "SKILL.md"),
        "---\nname: review\ndescription: Sync process fixture\n---\nOriginal\n",
      );
      const request = yield* localImportRequest(source, "2026-11-17T00:00:00.000Z");
      if (Option.isNone(request)) return yield* Effect.die("Missing source");
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const imported = yield* library.import.collection(request.value);
        const skill = imported.skills[0];
        if (!skill) return yield* Effect.die("Missing Skill");
        const plan = yield* library.plan(
          {
            _tag: "Enabled",
            changes: [
              {
                _tag: "Enable",
                subject: { _tag: "Skill", id: skill.skill_id },
                where: [{ kind: "global" }],
              },
            ],
          },
          { base: yield* library.read },
        );
        yield* library.apply({ _tag: "Apply", plan });
        yield* fs.writeFileString(
          join(source, "SKILL.md"),
          "---\nname: review\ndescription: Sync process fixture\n---\nUpdated\n",
        );
        const changed = yield* localImportRequest(source, "2026-11-17T01:00:00.000Z");
        if (Option.isNone(changed)) return yield* Effect.die("Missing changed source");
        yield* library.import.collection(changed.value);
      }).pipe(Effect.provide(layer), Effect.provideService(Clock.Clock, fixedClock));
      return;
    }
    const gate = Effect.andThen(
      Effect.sync(() => process.stdout.write(JSON.stringify({ kind: "paused", mode }) + "\n")),
      Effect.never,
    );
    let undoId: string | undefined;
    if (mode === "undo") {
      const folders: Array<FolderEvidence | LinkEvidence> = [];
      for (const name of ["first", "second"]) {
        const path = join(root, name);
        yield* fs.makeDirectory(path);
        yield* fs.writeFileString(join(path, "SKILL.md"), name);
        const evidence = yield* readPathEvidence(path);
        if (Option.isNone(evidence)) return yield* Effect.die("Missing Undo folder");
        folders.push(evidence.value);
      }
      undoId = yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const result = yield* library.setup([{ _tag: "Remove", folders }], {
          base: yield* library.read,
        });
        if (result._tag !== "Done") return yield* Effect.die("Setup stopped");
        return result.operationId;
      }).pipe(Effect.provide(layer), Effect.provideService(Clock.Clock, fixedClock));
    }
    const paused: FileSystem.FileSystem = {
      ...fs,
      rename: (from, to) =>
        Effect.gen(function* () {
          yield* fs.rename(from, to);
          if (run !== "kill") return;
          if (
            (mode === "sync-retire" && from === installed && to.includes(".skit-backups")) ||
            (mode === "sync-install" && to === installed) ||
            (mode === "undo" && to === join(root, "first"))
          )
            return yield* gate;
        }),
      chmod: (path, permissions) =>
        Effect.gen(function* () {
          yield* fs.chmod(path, permissions);
          if (run !== "kill" || mode !== "sync-save" || path !== join(home, "library.sqlite"))
            return;
          const operations = yield* loadOperations(home).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.orDie,
          );
          const operation = operations.find((x) => x._tag === "Pending");
          const step = operation?.steps[0]?.step;
          if (
            operation?._tag !== "Pending" ||
            step?._tag !== "Sync" ||
            step.phase !== "retire" ||
            operation.steps[0]?.status !== "Done" ||
            operation.steps[1]?.status !== "Pending"
          )
            return;
          const current = yield* loadLibrary(home).pipe(
            Effect.provideService(Digest.Digest, digest),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.orDie,
          );
          const after = yield* prepareLibrarySide(
            step.program.difference,
            current,
            "after",
            home,
          ).pipe(Effect.provideService(Digest.Digest, digest), Effect.orDie);
          if (canonicalJson(current) === canonicalJson(after)) return yield* gate;
        }),
    };
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const base = yield* library.read;
      if (mode === "undo") {
        if (!undoId) return yield* Effect.die("Missing setup");
        const plan = yield* library.plan({ _tag: "Undo", operationId: undoId }, { base });
        yield* library.apply({ _tag: "Apply", plan });
        return;
      }
      if (base._tag !== "Present") return yield* Effect.die("Missing Library");
      const manifest = yield* libraryManifestFromLocalState(base.state);
      const archives = yield* library.content.pack(base);
      const staged = yield* library.content.stage(manifest, {
        localArchives: archives,
        registry: { origin: "https://registry.fixture", token: Option.none() },
      });
      const plan = yield* library.plan(
        {
          _tag: "Sync",
          staged,
          acceptedBase: Option.none(),
          deviceSelection: Option.none(),
          pendingOrigin: Option.none(),
          remote: Option.some({ origin: "https://registry.fixture", libraryId: Option.none() }),
        },
        { base },
      );
      if (!Library.isRemoteSyncPlan(plan)) return yield* Effect.die("Missing Sync plan");
      const ancestry = {
        origin: "https://registry.fixture",
        library_id: "library_fixture",
        revision_id: "revision_fixture",
        base_manifest: manifest,
      };
      yield* library.apply({
        _tag: "ApplySynced",
        plan,
        receipt: {
          origin: ancestry.origin,
          libraryId: ancestry.library_id,
          revisionId: ancestry.revision_id,
          ancestry,
          manifestDigest: staged.manifestDigest,
        },
      });
    }).pipe(
      Effect.provide(layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, paused)))),
      Effect.provideService(Clock.Clock, fixedClock),
    );
  });
};

const Input = Schema.Struct({
  home: Schema.String,
  mode: Schema.Literals(["save", "import", "read"]),
  point: Schema.String,
  state: LibraryStateDocument,
  nextState: LibraryStateDocument,
  operation: OperationStatus,
  nextOperation: OperationStatus,
  action: HistoryAction,
});
const pause = (point: string) =>
  Effect.andThen(
    Effect.sync(() => process.stdout.write(JSON.stringify({ kind: "paused", point }) + "\n")),
    Effect.never,
  );

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const inputPath = process.argv[2];
  if (!inputPath) return yield* Effect.fail(new Error("Missing process fixture input"));
  const input = yield* Schema.decodeEffect(Schema.fromJsonString(Input))(
    yield* fs.readFileString(inputPath),
  );
  const path = libraryDatabasePath(input.home);
  let moved = false;
  const transformer: Statement.Transformer = (statement) =>
    Effect.gen(function* () {
      const [text] = statement.compile();
      if (input.mode === "save") {
        if (/UPDATE library_device\b/u.test(text)) {
          if (input.point === "before-rows") return yield* pause(input.point);
          moved = true;
        }
        if (
          moved &&
          input.point === "after-rows" &&
          /^SELECT document, operation_ids FROM library_audit_events/u.test(
            text.trim().replace(/\s+/gu, " "),
          )
        )
          return yield* pause(input.point);
      }
      if (text === "SELECT 1 AS test_acknowledgement" && input.point === "after-commit")
        return yield* pause(input.point);
      if (text === "SELECT 1 AS test_import_link" && input.point === "before-link")
        return yield* pause(input.point);
      if (text === "SELECT 1 AS test_import_fence" && input.point === "after-link")
        return yield* pause(input.point);
      return statement;
    });
  const files: FileSystem.FileSystem = {
    ...fs,
    link: (from, to) =>
      Effect.gen(function* () {
        if (input.mode === "import" && to === path && input.point === "before-link")
          yield* withLibraryDatabase(
            from,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`SELECT 1 AS test_import_link`;
            }),
            true,
          ).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.mapError((cause) =>
              systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "link",
                pathOrDescriptor: to,
                cause,
              }),
            ),
          );
        yield* fs.link(from, to);
        if (input.mode === "import" && to === path && input.point === "after-link")
          yield* withLibraryDatabase(
            to,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`SELECT 1 AS test_import_fence`;
            }),
            true,
          ).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.mapError((cause) =>
              systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "link",
                pathOrDescriptor: to,
                cause,
              }),
            ),
          );
      }),
  };
  yield* Effect.gen(function* () {
    if (input.mode === "save") {
      if (input.operation._tag !== "Pending" || input.nextOperation._tag !== "Pending")
        return yield* Effect.fail(new Error("Publication fixture requires pending programs"));
      yield* saveOperation(input.home, input.nextOperation, input.operation, input.action, {
        base: input.state,
        next: input.nextState,
      });
    } else yield* migrateLocalLibraryState(input.home);
    // This test-only statement runs after the real transaction and writer have completed.
    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`SELECT 1 AS test_acknowledgement`;
      }),
      true,
    );
    if (input.mode === "read") {
      const snapshot = yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const stored = yield* readDatabaseState(path);
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
      yield* Effect.sync(() =>
        process.stdout.write(JSON.stringify({ kind: "snapshot", snapshot }) + "\n"),
      );
    } else
      return yield* Effect.fail(
        new Error("Requested pause point was never reached: " + input.point),
      );
  }).pipe(
    Effect.provideService(Statement.CurrentTransformer, transformer),
    Effect.provideService(FileSystem.FileSystem, files),
  );
});

// An Effect.never pause must keep the process alive until the parent sends SIGKILL.
const keepAlive = setInterval(() => {}, 60_000);
const selected = Effect.gen(function* () {
  if (process.argv[2] === "sync-undo")
    return yield* applySyncUndoProcess(
      process.argv[3] ?? "",
      process.argv[4] ?? "",
      process.argv[5] ?? "",
    );
  return yield* program;
});
NodeRuntime.runMain(
  selected.pipe(
    Effect.provide(skitLayer),
    Effect.scoped,
    Effect.ensuring(Effect.sync(() => clearInterval(keepAlive))),
  ),
);
