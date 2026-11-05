import { recordedLibrary } from "../src/library/setup-intent.js";
import { emptyLibraryState } from "../src/library/library-state.js";
import { assert, it } from "@effect/vitest";
import { Context, Effect, Exit, FileSystem, Layer, Option, Schema } from "effect";
import { join } from "node:path";
import { deterministicTreeHash } from "../src/artifact/skit.js";
import { migratedMachineId } from "../src/library/entity-ids.js";
import { observePathEvidence } from "../src/library/folder-evidence.js";
import { Library } from "../src/library/library.js";
import { OperationStatus, type SetupStep } from "../src/library/store/state-schema.js";
import { inspectLocalLibraryState } from "../src/library/store/state-file.js";
import { skitLayer } from "../src/platform/layer.js";
import { inspectLibrary, libraryLayer } from "./helpers/library-store.js";

const machineId = migratedMachineId("019950c0-4c00-7000-8000-000000000001", "library-setup-test");

/**
 * A FileSystem that lets `commits` renames and links through, then crashes on the next: every
 * durable write setup makes ends in one of them (state.json, the receipt, the move).
 */
const crashingAfter = (commits: number) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) => {
      let left = commits;
      const crash = Effect.suspend(() => (left-- <= 0 ? Effect.die("crash") : Effect.void));
      return {
        ...fs,
        rename: (from: string, to: string) => Effect.andThen(crash, fs.rename(from, to)),
        link: (from: string, to: string) => Effect.andThen(crash, fs.link(from, to)),
      };
    }),
  );

/** Build the Library over `home`, its file system optionally replaced, and use it. */
const withLibrary = <A, E, R>(
  home: string,
  use: (library: Library.Interface) => Effect.Effect<A, E, R>,
  fileSystem = crashingAfter(Number.POSITIVE_INFINITY),
) =>
  Effect.gen(function* () {
    const layer = libraryLayer(home).pipe(Layer.provide(fileSystem));
    return yield* use(Context.get(yield* Layer.build(layer), Library.Service));
  });

/** A home, a skill folder setup can remove, and the evidence a review would have recorded. */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-library-setup-" });
  const home = join(workspace, "home");
  const skills = join(workspace, "skills");
  const folder = join(skills, "review");
  yield* fs.makeDirectory(folder, { recursive: true });
  yield* fs.writeFileString(join(folder, "SKILL.md"), "---\nname: review\n---\nReview.\n");
  const evidence = yield* observePathEvidence(folder);
  assert.isTrue(Option.isSome(evidence));
  if (Option.isNone(evidence)) return yield* Effect.die("no evidence");
  const remove: SetupStep = { _tag: "Remove", folders: [evidence.value] };
  return { fs, workspace, home, folder, remove };
});

/** Build the Library over `home` as the next SKIT run would: what its startup recovery did. */
const restart = (home: string) => withLibrary(home, (library) => Effect.succeed(library.startup));

/** The operation records in `state.json`, read as a file: building a store would recover them. */
const recordedOperations = (home: string) =>
  Effect.gen(function* () {
    const inspected = yield* inspectLocalLibraryState(home);
    return inspected.present
      ? yield* Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(inspected.state.operations)
      : [];
  });

const auditLines = (home: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(join(home, "audit.jsonl")).pipe(
      Effect.map((text) => text.trim().split("\n").filter(Boolean).length),
      Effect.orElseSucceed(() => 0),
    ),
  );

it.effect("removes a reviewed folder into removed/<operationId>/ and records it Done", () =>
  Effect.gen(function* () {
    const { fs, home, folder, remove } = yield* fixture;
    const result = yield* withLibrary(home, (library) =>
      Effect.flatMap(library.read, (base) => library.setup([remove], { base })),
    );

    assert.strictEqual(result._tag, "Done");
    if (result._tag !== "Done") return;
    const saved = join(home, "removed", result.operationId, "step-1", "1-review");
    assert.isFalse(yield* fs.exists(folder));
    assert.isTrue(yield* fs.exists(saved));
    assert.isTrue(
      yield* fs.exists(join(home, "removed", result.operationId, "step-1", "receipt.json")),
    );
    assert.deepStrictEqual(result.recoveryDirectories, [
      join(home, "removed", result.operationId, "step-1"),
    ]);
    // The Done record keeps every step with its evidence, for undo.
    assert.deepStrictEqual(yield* recordedOperations(home), [
      OperationStatus.cases.Done.make({
        operationId: result.operationId,
        steps: [
          {
            step: remove,
            before: remove._tag === "Remove" ? remove.folders : [],
            after:
              remove._tag === "Remove"
                ? remove.folders.map((folder) => ({
                    _tag: "Absent" as const,
                    path: folder.path,
                    parent: folder.parent,
                  }))
                : [],
            status: "Done",
          },
        ],
        // Moving a folder aside changes nothing the Library records.
        before: recordedLibrary(emptyLibraryState()),
        after: recordedLibrary(emptyLibraryState()),
      }),
    ]);
    assert.strictEqual(yield* auditLines(home), 1);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

/** A home with a source to import and a folder to remove, as one setup. */
const importFixture = Effect.gen(function* () {
  const { fs, workspace, home, folder, remove } = yield* fixture;
  const source = join(workspace, "source");
  yield* fs.makeDirectory(source, { recursive: true });
  yield* fs.writeFileString(join(source, "SKILL.md"), "raw Skill bytes\n");
  const imported: SetupStep = {
    _tag: "Import",
    request: {
      machineId,
      source: { type: "local", path: source },
      input: source,
      importedAt: "2026-11-04T00:00:00.000Z",
      skills: [
        {
          name: "review",
          sourcePath: source,
          relativePath: ".",
          currentHash: yield* deterministicTreeHash(source),
        },
      ],
      lockFileEntries: [],
    },
  };
  return { fs, home, folder, steps: [imported, remove] };
});

// An import setup commits: the record, the Collection Version, the import's state, the Import's
// Done mark, then the removal's receipt, move and Done mark, then the operation's Done mark.
it.effect("a crash after an import saved, before its Done mark, re-runs the import", () =>
  Effect.gen(function* () {
    const { fs, home, folder, steps } = yield* importFixture;
    const crashed = yield* Effect.exit(
      withLibrary(
        home,
        (library) => Effect.flatMap(library.read, (base) => library.setup(steps, { base })),
        crashingAfter(3),
      ),
    );
    assert.isTrue(Exit.isFailure(crashed));
    const [interrupted] = yield* recordedOperations(home);
    if (interrupted?._tag !== "Pending") return assert.fail("setup is not Pending");
    assert.deepStrictEqual(
      interrupted.steps.map(({ status }) => status),
      ["Pending", "Pending"],
    );

    const startup = yield* restart(home);

    assert.deepStrictEqual(startup, { finished: [interrupted.operationId], stopped: [] });
    assert.isFalse(yield* fs.exists(folder));
    const inspected = yield* inspectLibrary(home);
    assert.isTrue(inspected.present && inspected.state.collections.length === 1);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("the import's Done mark saves the Collection Version it retained", () =>
  Effect.gen(function* () {
    const { fs, home, folder, steps } = yield* importFixture;
    yield* Effect.exit(
      withLibrary(
        home,
        (library) => Effect.flatMap(library.read, (base) => library.setup(steps, { base })),
        crashingAfter(4),
      ),
    );
    const inspected = yield* inspectLocalLibraryState(home);
    if (!inspected.present) return assert.fail("no Library");
    const [interrupted] = yield* recordedOperations(home);
    if (interrupted?._tag !== "Pending") return assert.fail("setup is not Pending");
    assert.deepStrictEqual(
      interrupted.steps.map(({ status, after }) => ({ status, after })),
      [
        {
          status: "Done",
          after: [
            {
              _tag: "Retained",
              hash: inspected.state.collection_versions[0]!.hash,
              collectionId: inspected.state.collections[0]!.collection_id,
            },
          ],
        },
        { status: "Pending", after: interrupted.steps[1]!.after },
      ],
    );

    const startup = yield* restart(home);

    assert.deepStrictEqual(startup, { finished: [interrupted.operationId], stopped: [] });
    assert.isFalse(yield* fs.exists(folder));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// Commits a one-folder removal makes, in order: the record, the receipt, the move, the Done mark.
for (const [commits, after] of [
  [1, "the record"],
  [2, "the receipt"],
  [3, "the move"],
  [4, "the Done mark"],
] as const)
  it.effect(`a crash after ${after} is finished by running setup again`, () =>
    Effect.gen(function* () {
      const { fs, home, folder, remove } = yield* fixture;
      const crashed = yield* Effect.exit(
        withLibrary(
          home,
          (library) => Effect.flatMap(library.read, (base) => library.setup([remove], { base })),
          crashingAfter(commits),
        ),
      );
      assert.isTrue(Exit.isFailure(crashed));
      const [operation] = yield* recordedOperations(home);
      assert.strictEqual(operation?._tag, "Pending");
      if (operation === undefined) return;

      const startup = yield* restart(home);

      assert.deepStrictEqual(startup, { finished: [operation.operationId], stopped: [] });
      assert.isFalse(yield* fs.exists(folder));
      const saved = join(home, "removed", operation.operationId, "step-1", "1-review");
      assert.strictEqual(
        yield* fs.readFileString(join(saved, "SKILL.md")),
        "---\nname: review\n---\nReview.\n",
      );
      assert.deepStrictEqual(yield* recordedOperations(home), [
        OperationStatus.cases.Done.make({
          operationId: operation.operationId,
          steps: operation.steps.map((step) => ({ ...step, status: "Done" as const })),
          before: operation.before,
          after: operation.before,
        }),
      ]);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("a re-run stops, moving nothing, when the folder changed after the receipt", () =>
  Effect.gen(function* () {
    const { fs, home, folder, remove } = yield* fixture;
    yield* Effect.exit(
      withLibrary(
        home,
        (library) => Effect.flatMap(library.read, (base) => library.setup([remove], { base })),
        crashingAfter(2),
      ),
    );
    const [operation] = yield* recordedOperations(home);
    if (operation === undefined) return assert.fail("no operation recorded");
    yield* fs.writeFileString(join(folder, "notes.md"), "the user's edit\n");

    const startup = yield* restart(home);

    assert.deepStrictEqual(startup.finished, []);
    const [result] = startup.stopped;
    if (result === undefined) return assert.fail("not stopped");
    assert.strictEqual(result.reason._tag, "EvidenceDiffers");
    assert.strictEqual(yield* fs.readFileString(join(folder, "notes.md")), "the user's edit\n");
    // The Stopped record keeps every step with its evidence, as recorded before the stop.
    const [stopped] = yield* recordedOperations(home);
    assert.deepStrictEqual(
      stopped,
      OperationStatus.cases.Stopped.make({
        operationId: operation.operationId,
        steps: operation.steps,
        reason: result.reason,
        before: operation.before,
        after: operation.before,
      }),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a re-run stops when something new is where a moved folder was", () =>
  Effect.gen(function* () {
    const { fs, home, folder, remove } = yield* fixture;
    yield* Effect.exit(
      withLibrary(
        home,
        (library) => Effect.flatMap(library.read, (base) => library.setup([remove], { base })),
        crashingAfter(3),
      ),
    );
    const [operation] = yield* recordedOperations(home);
    if (operation === undefined) return assert.fail("no operation recorded");
    yield* fs.makeDirectory(folder);
    yield* fs.writeFileString(join(folder, "SKILL.md"), "a new skill\n");

    const startup = yield* restart(home);

    assert.deepStrictEqual(
      startup.stopped.map(({ operationId }) => operationId),
      [operation.operationId],
    );
    assert.strictEqual(yield* fs.readFileString(join(folder, "SKILL.md")), "a new skill\n");
    assert.isTrue(
      yield* fs.exists(join(home, "removed", operation.operationId, "step-1", "1-review")),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("refuses a setup reviewed against another revision, writing nothing", () =>
  Effect.gen(function* () {
    const { fs, home, folder, remove } = yield* fixture;
    const error = yield* withLibrary(home, (library) =>
      Effect.flatMap(library.read, (base) =>
        library.setup([remove], {
          base: { ...base, revision: Library.Revision.make("sha256:elsewhere") },
        }),
      ),
    ).pipe(Effect.flip);

    assert.strictEqual(error._tag, "Library.StalePlan");
    assert.isTrue(yield* fs.exists(folder));
    assert.isFalse(yield* fs.exists(join(home, "state.json")));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("refuses to remove the Library's own storage", () =>
  Effect.gen(function* () {
    const { fs, home } = yield* fixture;
    yield* fs.makeDirectory(join(home, "originals"), { recursive: true });
    const own = yield* observePathEvidence(join(home, "originals"));
    if (Option.isNone(own)) return assert.fail("no evidence");
    const error = yield* withLibrary(home, (library) =>
      Effect.flatMap(library.read, (base) =>
        library.setup([{ _tag: "Remove", folders: [own.value] }], { base }),
      ),
    ).pipe(Effect.flip);

    assert.strictEqual(error._tag, "Library.InvalidIntent");
    assert.isTrue(yield* fs.exists(join(home, "originals")));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a later setup replaces Done records and keeps Stopped ones", () =>
  Effect.gen(function* () {
    const { home, remove } = yield* fixture;
    const first = yield* withLibrary(home, (library) =>
      Effect.flatMap(library.read, (base) => library.setup([remove], { base })),
    );
    // A second removal of the same, now moved, folder stops: nothing is where it was reviewed.
    const second = yield* withLibrary(home, (library) =>
      Effect.flatMap(library.read, (base) => library.setup([remove], { base })),
    );
    const third = yield* withLibrary(home, (library) =>
      Effect.flatMap(library.read, (base) => library.setup([], { base })),
    );

    assert.strictEqual(first._tag, "Done");
    assert.strictEqual(second._tag, "Stopped");
    assert.strictEqual(third._tag, "Done");
    const history = yield* withLibrary(home, (library) => library.history);
    assert.deepStrictEqual(history.operations, yield* recordedOperations(home));
    assert.deepStrictEqual(
      (yield* recordedOperations(home)).map(({ _tag, operationId }) => ({ _tag, operationId })),
      [
        { _tag: "Stopped", operationId: second.operationId },
        { _tag: "Done", operationId: third.operationId },
      ],
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
