import { openLibrary } from "./helpers/library-store.js";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Option, Predicate, Result, Schema } from "effect";
import { join } from "node:path";
import { deterministicTreeHash } from "../src/artifact/skit.js";
import { makeOperationId, migratedMachineId } from "../src/library/entity-ids.js";
import { collectionVersionPath } from "../src/library/collection-version.js";
import {
  emptyLibraryState,
  libraryManifestFromLocalState,
  type LibraryState,
} from "../src/library/library-state.js";
import { recordedLibrary } from "../src/library/setup-intent.js";
import { readSnapshotArchive } from "../src/library/snapshot-archive.js";
import { OperationStatus, StepError } from "../src/library/store/state-schema.js";
import { InvalidLibraryState, LibraryChanged } from "../src/library/failures.js";
import { HomeBusy } from "../src/platform/lock-failures.js";
import { TreeError } from "../src/shared/tree-error.js";
import { badArgument, systemError } from "effect/PlatformError";

import {
  libraryOriginalsPath,
  LibraryWriter,
  loadLibrary,
  writeLibrary,
} from "../src/library/store/library-store.js";
import { Hash } from "../src/shared/hash.js";
import { skitLayer } from "../src/platform/layer.js";
import { acquireFileLock } from "../src/platform/file-lock.js";

const machineId = migratedMachineId("019950c0-4c00-7000-8000-000000000001", "library-store-test");

const library = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-library-store-" });
  const home = join(workspace, "home");
  const source = join(workspace, "source");
  yield* fs.makeDirectory(source, { recursive: true });
  yield* fs.writeFileString(join(source, "SKILL.md"), "raw Skill bytes\n");
  yield* Effect.scoped(
    Effect.gen(function* () {
      const owner = yield* openLibrary(home);
      return yield* owner.import.collection({
        machineId,
        source: { type: "local", path: source },
        input: source,
        importedAt: "2026-09-17T00:00:00.000Z",
        skills: [
          {
            name: "review",
            sourcePath: source,
            relativePath: ".",
            currentHash: yield* deterministicTreeHash(source),
          },
        ],
        lockFileEntries: [],
      });
    }),
  );
  /** Save `next` over `base` in a write of its own. */
  const save = (next: LibraryState, base: LibraryState) =>
    writeLibrary(
      home,
      Effect.flatMap(LibraryWriter, (writer) => writer.save(next, base)),
    );
  return { save, home, path: join(home, "state.json") };
});

it.effect("refuses to save a state its own loader would reject", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { save, home, path } = yield* library;
    const before = yield* fs.readFileString(path);
    const state = yield* loadLibrary(home);

    // Duplicate Collection IDs satisfy the state schema but not the portable manifest.
    const error = yield* save(
      { ...state, collections: [...state.collections, ...state.collections] },
      state,
    ).pipe(Effect.flip);

    assert.strictEqual(error._tag, "InvalidLibraryState");
    assert.strictEqual(yield* fs.readFileString(path), before);
    assert.deepStrictEqual(yield* loadLibrary(home), state);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("accepts exactly one of two writes planned from the same state", () =>
  Effect.gen(function* () {
    const { save, home } = yield* library;
    const base = yield* loadLibrary(home);
    const enabled = base.skills.map((skill) => ({ skill: skill.skill_id }));
    const global = { ...base, enabled };
    const local = { ...base, repositories: [{ root: "/workspace", enabled }] };

    const outcomes = yield* Effect.all(
      [global, local].map((next) => Effect.result(save(next, base))),
      { concurrency: "unbounded" },
    );

    const winners = [global, local].filter((_, index) => Result.isSuccess(outcomes[index]!));
    const losers = outcomes.flatMap((outcome) =>
      Result.isFailure(outcome) ? [outcome.failure._tag] : [],
    );
    assert.strictEqual(winners.length, 1);
    assert.deepStrictEqual(losers, ["LibraryChanged"]);
    assert.deepStrictEqual(yield* loadLibrary(home), winners[0]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("accepts exactly one of two concurrent saves sharing one write", () =>
  Effect.gen(function* () {
    const { home } = yield* library;
    const base = yield* loadLibrary(home);
    const enabled = base.skills.map((skill) => ({ skill: skill.skill_id }));
    const global = { ...base, enabled };
    const local = { ...base, repositories: [{ root: "/workspace", enabled }] };

    // Both forks inherit the write's lock, so only the save mutex can serialize them.
    const outcomes = yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        return yield* Effect.all(
          [global, local].map((next) => Effect.result(writer.save(next, base))),
          { concurrency: "unbounded" },
        );
      }),
    );

    const winners = [global, local].filter((_, index) => Result.isSuccess(outcomes[index]!));
    const losers = outcomes.flatMap((outcome) =>
      Result.isFailure(outcome) ? [outcome.failure._tag] : [],
    );
    assert.strictEqual(winners.length, 1);
    assert.deepStrictEqual(losers, ["LibraryChanged"]);
    assert.deepStrictEqual(yield* loadLibrary(home), winners[0]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("refuses to save while another holder has the lock", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { save, home, path } = yield* library;
    const state = yield* loadLibrary(home);
    const before = yield* fs.readFileString(path);
    // Another holder, as another process would be.
    yield* acquireFileLock(join(home, "lock.sqlite"));

    const error = yield* save({ ...state, enabled: [] }, state).pipe(Effect.flip);

    assert.strictEqual(error._tag, "HomeBusy");
    assert.strictEqual(yield* fs.readFileString(path), before);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("makes a save that outlives its write acquire the lock again", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { home, path } = yield* library;
    const base = yield* loadLibrary(home);
    const before = yield* fs.readFileString(path);
    const resume = yield* Deferred.make<void>();
    const child = yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        return yield* Deferred.await(resume).pipe(
          Effect.andThen(writer.save({ ...base, enabled: [] }, base)),
          Effect.forkDetach,
        );
      }),
    );
    // Another holder takes the lock once the write has released it.
    yield* acquireFileLock(join(home, "lock.sqlite"));
    yield* Deferred.succeed(resume, undefined);

    assert.strictEqual((yield* Effect.flip(Fiber.join(child)))._tag, "HomeBusy");
    assert.strictEqual(yield* fs.readFileString(path), before);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.live("keeps the lock until a save already under way in a forked fiber has finished", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { home, path } = yield* library;
    const lock = join(home, "lock.sqlite");
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let armed = false;
    // Pause the save inside its check-and-write, at its read of the current state.
    const gatedFs: FileSystem.FileSystem = {
      ...fs,
      readFileString: (file, encoding) =>
        fs.readFileString(file, encoding).pipe(
          Effect.tap(() =>
            file === path && armed
              ? Effect.sync(() => {
                  armed = false;
                }).pipe(
                  Effect.andThen(Deferred.succeed(entered, undefined)),
                  Effect.andThen(Deferred.await(resume)),
                )
              : Effect.void,
          ),
        ),
    };
    const base = yield* loadLibrary(home);
    const next = { ...base, enabled: [] };
    let child: Fiber.Fiber<void, unknown> | undefined;
    const owner = yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        armed = true;
        child = yield* writer.save(next, base).pipe(Effect.forkDetach);
        yield* Deferred.await(entered);
      }),
    ).pipe(Effect.provideService(FileSystem.FileSystem, gatedFs), Effect.forkChild);

    yield* Deferred.await(entered);
    yield* Effect.sleep("50 millis");
    // The owner's program has returned, but its release waits for the save it lent the lock to.
    assert.isUndefined(owner.pollUnsafe());
    assert.isFalse(yield* Effect.isSuccess(Effect.scoped(acquireFileLock(lock))));

    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(child!);
    yield* Fiber.join(owner);
    assert.isTrue(yield* Effect.isSuccess(Effect.scoped(acquireFileLock(lock))));
    assert.deepStrictEqual(yield* loadLibrary(home), next);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

/** What sync sends for a state: its portable manifest and the packed retained bytes. */
const synced = (state: LibraryState, originalsPath: string) =>
  Effect.all({
    manifest: libraryManifestFromLocalState(state),
    pack: Effect.forEach(state.collection_versions, (version) =>
      readSnapshotArchive(collectionVersionPath(originalsPath, version.hash)),
    ),
  });

it.effect("keeps operation records on this device: saved and loaded, never synced", () =>
  Effect.gen(function* () {
    const { save, home } = yield* library;
    const base = yield* loadLibrary(home);
    const hash = Hash.make(`sha256:${"a".repeat(64)}`);
    const parent = { path: join(home, "skills"), dev: 1n, ino: 2n };
    const folder = {
      _tag: "Directory" as const,
      path: join(home, "skills", "review"),
      dev: 1n,
      ino: 18446744073709551615n,
      parent,
      contentHash: hash,
      treeHash: hash,
      marker: Option.none(),
    };
    const removed = { _tag: "Absent" as const, path: folder.path, parent };
    const operations: OperationStatus[] = [
      OperationStatus.cases.Pending.make({
        operationId: makeOperationId(),
        steps: [
          {
            step: { _tag: "Remove", folders: [folder] },
            before: [folder],
            after: [removed],
            status: "Pending",
          },
        ],
        before: recordedLibrary(base),
      }),
      OperationStatus.cases.Stopped.make({
        operationId: makeOperationId(),
        steps: [],
        reason: {
          _tag: "EvidenceDiffers",
          step: 0,
          path: folder.path,
          expected: { before: Option.some(folder), after: Option.none() },
        },
        before: recordedLibrary(base),
        after: recordedLibrary(base),
      }),
      OperationStatus.cases.Done.make({
        operationId: makeOperationId(),
        steps: [],
        before: recordedLibrary(base),
        after: recordedLibrary(base),
      }),
    ];
    const next = {
      ...base,
      operations: yield* Schema.encodeEffect(Schema.Array(OperationStatus))(operations),
    };

    yield* save(next, base);
    const loaded = yield* loadLibrary(home);

    assert.deepStrictEqual(loaded, next);
    assert.deepStrictEqual(
      yield* Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(loaded.operations),
      operations,
    );
    assert.deepStrictEqual(
      yield* synced(loaded, libraryOriginalsPath(home)),
      yield* synced(base, libraryOriginalsPath(home)),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a stopped operation keeps its step's error through state.json, in each stored form",
  () =>
    Effect.gen(function* () {
      const { save, home } = yield* library;
      const errors: readonly StepError[] = [
        new TreeError({ reason: { _tag: "UnsupportedEntry", path: "/skills/review/socket" } }),
        new HomeBusy({ path: "/home/lock.sqlite" }),
        new LibraryChanged({ path: "/home/state.json" }),
        new InvalidLibraryState({ path: "/home/state.json", detail: "invalid setup record" }),
        systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "rename",
          description: "operation not permitted",
          syscall: "rename",
          pathOrDescriptor: "/skills/review",
        }),
        badArgument({ module: "FileSystem", method: "open", description: "bad flag" }),
        {
          _tag: "PnpmSkillManaged",
          code: "CONFLICT",
          message: "/skills/review is managed by pnpm (a-package); SKIT leaves it in place.",
          remediation: "Manage this Skill through pnpm's dependency and permission settings.",
        },
      ];
      const operations = errors.map((error, step) =>
        OperationStatus.cases.Stopped.make({
          operationId: makeOperationId(),
          steps: [],
          reason: { _tag: "StepFailed", step, error },
          before: recordedLibrary(emptyLibraryState()),
          after: recordedLibrary(emptyLibraryState()),
        }),
      );
      const base = yield* loadLibrary(home);
      yield* save(
        {
          ...base,
          operations: yield* Schema.encodeEffect(Schema.Array(OperationStatus))(operations),
        },
        base,
      );

      const loaded = yield* Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(
        (yield* loadLibrary(home)).operations,
      );

      // Each error reads back as the same kind, with every stored field equal.
      const fields = (error: unknown) =>
        Predicate.isError(error)
          ? {
              kind: error.constructor.name,
              message: error.message,
              ...Object.fromEntries(Object.entries(error)),
            }
          : error;
      assert.deepStrictEqual(
        loaded.map((operation) =>
          operation._tag === "Stopped" && operation.reason._tag === "StepFailed"
            ? fields(operation.reason.error)
            : undefined,
        ),
        errors.map(fields),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("reads a recorded LibraryBusy failure without rewriting it, and encodes HomeBusy", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-old-home-busy-" });
    const state = emptyLibraryState();
    const bytes = JSON.stringify({
      ...state,
      operations: [
        {
          _tag: "Stopped",
          operationId: makeOperationId(),
          steps: [],
          before: recordedLibrary(state),
          after: recordedLibrary(state),
          reason: {
            _tag: "StepFailed",
            step: 0,
            error: { _tag: "LibraryBusy", path: "/home/lock.sqlite" },
          },
        },
      ],
    });
    yield* fs.writeFileString(join(home, "state.json"), bytes);
    const owner = yield* openLibrary(home);
    const snapshot = yield* owner.read;
    assert.strictEqual(snapshot._tag, "Present");
    if (snapshot._tag !== "Present") return;
    const operations = yield* Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(
      snapshot.state.operations,
    );
    const operation = operations[0];
    assert.strictEqual(operation?._tag, "Stopped");
    if (operation?._tag !== "Stopped" || operation.reason._tag !== "StepFailed")
      return yield* Effect.die("Missing stopped failure");
    assert.strictEqual(operation.reason.error._tag, "HomeBusy");
    assert.deepStrictEqual(yield* Schema.encodeEffect(StepError)(operation.reason.error), {
      _tag: "HomeBusy",
      path: "/home/lock.sqlite",
    });
    assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), bytes);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
