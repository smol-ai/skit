import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Option, Result, Schema } from "effect";
import { join } from "node:path";
import { deterministicTreeHash } from "../src/artifact/skit.js";
import { makeOperationId, migratedMachineId } from "../src/library/entity-ids.js";
import { collectionVersionPath } from "../src/library/collection-version.js";
import { libraryManifestFromLocalState, type LibraryState } from "../src/library/library-state.js";
import { readSnapshotArchive } from "../src/library/snapshot-archive.js";
import { OperationStatus } from "../src/library/store/state-schema.js";
import { importCollection } from "../src/library/import-collection.js";
import { LibraryStore, withLibraryWriter } from "../src/library/store/library-store.js";
import { libraryStoreLayer } from "../src/library/library-store-layer.js";
import { withHomeLock } from "../src/library/store/writer-lock.js";
import { Hash } from "../src/vocabulary.js";
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
  const inLibrary = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(libraryStoreLayer({ home })));
  yield* inLibrary(
    Effect.scoped(
      importCollection({
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
      }),
    ),
  );
  return { inLibrary, home, path: join(home, "state.json") };
});

it.effect("refuses to save a state its own loader would reject", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { inLibrary, path } = yield* library;
    const before = yield* fs.readFileString(path);
    const store = yield* inLibrary(Effect.service(LibraryStore));
    const state = yield* store.load;

    // Duplicate Collection IDs satisfy the state schema but not the portable manifest.
    const error = yield* store
      .save({ ...state, collections: [...state.collections, ...state.collections] }, state)
      .pipe(Effect.flip);

    assert.strictEqual(error._tag, "InvalidLibraryState");
    assert.strictEqual(yield* fs.readFileString(path), before);
    assert.deepStrictEqual(yield* store.load, state);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("accepts exactly one of two saves planned from the same state", () =>
  Effect.gen(function* () {
    const { inLibrary } = yield* library;
    const store = yield* inLibrary(Effect.service(LibraryStore));
    const base = yield* store.load;
    const enabled = base.skills.map((skill) => ({ skill: skill.skill_id }));
    const global = { ...base, enabled };
    const local = { ...base, repositories: [{ root: "/workspace", enabled }] };

    const outcomes = yield* Effect.all(
      [global, local].map((next) => Effect.result(store.save(next, base))),
      { concurrency: "unbounded" },
    );

    const winners = [global, local].filter((_, index) => Result.isSuccess(outcomes[index]!));
    const losers = outcomes.flatMap((outcome) =>
      Result.isFailure(outcome) ? [outcome.failure._tag] : [],
    );
    assert.strictEqual(winners.length, 1);
    assert.deepStrictEqual(losers, ["LibraryChanged"]);
    assert.deepStrictEqual(yield* store.load, winners[0]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("accepts exactly one of two concurrent saves sharing one held writer lock", () =>
  Effect.gen(function* () {
    const { inLibrary } = yield* library;
    const store = yield* inLibrary(Effect.service(LibraryStore));
    const base = yield* store.load;
    const enabled = base.skills.map((skill) => ({ skill: skill.skill_id }));
    const global = { ...base, enabled };
    const local = { ...base, repositories: [{ root: "/workspace", enabled }] };

    // Both forks inherit the outer lock, so only the save mutex can serialize them.
    const outcomes = yield* withHomeLock(
      store.home,
      Effect.all(
        [global, local].map((next) => Effect.result(store.save(next, base))),
        { concurrency: "unbounded" },
      ),
    );

    const winners = [global, local].filter((_, index) => Result.isSuccess(outcomes[index]!));
    const losers = outcomes.flatMap((outcome) =>
      Result.isFailure(outcome) ? [outcome.failure._tag] : [],
    );
    assert.strictEqual(winners.length, 1);
    assert.deepStrictEqual(losers, ["LibraryChanged"]);
    assert.deepStrictEqual(yield* store.load, winners[0]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("refuses to save while another holder has the lock", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { inLibrary, path } = yield* library;
    const store = yield* inLibrary(Effect.service(LibraryStore));
    const state = yield* store.load;
    const before = yield* fs.readFileString(path);
    // Another holder, as another process would be.
    yield* acquireFileLock(join(store.home, "lock.sqlite"));

    const error = yield* store.save({ ...state, enabled: [] }, state).pipe(Effect.flip);

    assert.strictEqual(error._tag, "LibraryBusy");
    assert.strictEqual(yield* fs.readFileString(path), before);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("makes a writer that outlives its action acquire the lock again", () =>
  Effect.gen(function* () {
    const { inLibrary, home } = yield* library;
    const resume = yield* Deferred.make<void>();
    let ran = false;
    const child = yield* inLibrary(
      withLibraryWriter(
        Deferred.await(resume).pipe(
          Effect.andThen(
            withLibraryWriter(
              Effect.sync(() => {
                ran = true;
              }),
            ),
          ),
          Effect.forkDetach,
        ),
      ),
    );
    // Another holder takes the lock once the owner has released it.
    yield* acquireFileLock(join(home, "lock.sqlite"));
    yield* Deferred.succeed(resume, undefined);

    assert.strictEqual((yield* Effect.flip(Fiber.join(child)))._tag, "LibraryBusy");
    assert.isFalse(ran);
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
    const store = yield* Effect.service(LibraryStore).pipe(
      Effect.provide(libraryStoreLayer({ home })),
      Effect.provideService(FileSystem.FileSystem, gatedFs),
    );
    const base = yield* store.load;
    const next = { ...base, enabled: [] };
    let child: Fiber.Fiber<void, unknown> | undefined;
    const owner = yield* withHomeLock(
      home,
      Effect.gen(function* () {
        armed = true;
        child = yield* store.save(next, base).pipe(Effect.forkDetach);
        yield* Deferred.await(entered);
      }),
    ).pipe(Effect.forkChild);

    yield* Deferred.await(entered);
    yield* Effect.sleep("50 millis");
    // The owner's program has returned, but its release waits for the save it lent the lock to.
    assert.isUndefined(owner.pollUnsafe());
    assert.isFalse(yield* Effect.isSuccess(Effect.scoped(acquireFileLock(lock))));

    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(child!);
    yield* Fiber.join(owner);
    assert.isTrue(yield* Effect.isSuccess(Effect.scoped(acquireFileLock(lock))));
    assert.deepStrictEqual(yield* store.load, next);
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
    const { inLibrary, home } = yield* library;
    const store = yield* inLibrary(Effect.service(LibraryStore));
    const base = yield* store.load;
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
      }),
      OperationStatus.cases.Stopped.make({
        operationId: makeOperationId(),
        reason: {
          _tag: "EvidenceDiffers",
          step: 0,
          path: folder.path,
          expected: { before: Option.some(folder), after: Option.none() },
        },
      }),
      OperationStatus.cases.Done.make({ operationId: makeOperationId() }),
    ];
    const next = {
      ...base,
      operations: yield* Schema.encodeEffect(Schema.Array(OperationStatus))(operations),
    };

    yield* store.save(next, base);
    const loaded = yield* store.load;

    assert.deepStrictEqual(loaded, next);
    assert.deepStrictEqual(
      yield* Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(loaded.operations),
      operations,
    );
    assert.deepStrictEqual(
      yield* synced(loaded, store.originalsPath),
      yield* synced(base, store.originalsPath),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
