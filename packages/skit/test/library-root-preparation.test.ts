import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Schema } from "effect";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { LibraryState } from "../src/library/library-state.js";
import { observePathEvidence } from "../src/library/folder-evidence.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { makeMachineId } from "../src/library/entity-ids.js";
import { skitLayer } from "../src/platform/layer.js";
import { testRoots } from "./helpers/library-store.js";

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(LibraryState));
type Boundary = "recorded" | "directory" | "prepared";
const fixture = Effect.fn("test.rootPreparation.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "skit-recorded-roots-" }),
  );
  const home = join(root, "library");
  const agents = join(root, "agents");
  const claude = join(root, "claude", "skills");
  const source = join(agents, "review");
  const bytes = "---\nname: review\ndescription: Recorded roots\n---\nReviewed bytes\n";
  yield* fs.makeDirectory(source, { recursive: true });
  yield* fs.writeFileString(join(source, "SKILL.md"), bytes);
  const observed = yield* observePathEvidence(source);
  const request = yield* localImportRequest(source, "2026-11-05T00:00:00.000Z");
  if (Option.isNone(observed) || observed.value._tag !== "Directory" || Option.isNone(request))
    return yield* Effect.die("Invalid independent fixture");
  const steps: readonly Library.SetupStep[] = [
    { _tag: "Import", request: request.value },
    {
      _tag: "Manage",
      mode: "new",
      selections: [
        {
          mode: "new",
          name: "review",
          source: observed.value,
          importFrom: { _tag: "Step", step: 0 },
          currentHash: Option.some(observed.value.treeHash),
          equalCopies: [],
          duplicates: Option.none(),
          approvedCopies: [],
          approvedSymlinks: [],
          ownership: Option.some({ harnesses: ["codex"], machineId: Option.some(makeMachineId()) }),
        },
      ],
      routing: {
        active: ["agents", "claude"],
        destinations: [
          { scope: { kind: "global" }, destination: "agents", root: agents },
          { scope: { kind: "global" }, destination: "claude", root: claude },
        ],
        readable: [{ scope: { kind: "global" }, harness: "codex", root: agents }],
      },
    },
  ];
  return {
    fs,
    root,
    home,
    agents,
    claude,
    source,
    bytes,
    steps,
    state: join(home, "state.json"),
    layer: Library.layer({ home, roots: testRoots(home) }),
  };
});
type Fixture = Effect.Success<ReturnType<typeof fixture>>;

const interrupt = Effect.fn("test.rootPreparation.interrupt")(function* (
  f: Fixture,
  boundary: Boundary,
) {
  let stopped = false;
  const files: FileSystem.FileSystem = {
    ...f.fs,
    makeDirectory: (path, options) =>
      Effect.gen(function* () {
        if (path === f.claude) {
          const state = yield* decode(yield* f.fs.readFileString(f.state)).pipe(Effect.orDie);
          assert.isTrue(
            state.operations.some(
              (operation) =>
                operation._tag === "Pending" &&
                operation.preparation?.roots.some((root) => root.path === path),
            ),
          );
        }
        yield* f.fs.makeDirectory(path, options);
        if (!stopped && boundary === "directory" && path === f.claude) {
          stopped = true;
          return yield* Effect.die("process exited after creating a recorded root");
        }
      }),
    rename: (from, to) =>
      Effect.gen(function* () {
        const state =
          to === f.state
            ? yield* decode(yield* f.fs.readFileString(from)).pipe(Effect.orDie)
            : undefined;
        yield* f.fs.rename(from, to);
        const pending = state?.operations.find((operation) => operation._tag === "Pending");
        if (
          !stopped &&
          pending?._tag === "Pending" &&
          pending.preparation &&
          ((boundary === "recorded" && !pending.preparation.done) ||
            (boundary === "prepared" && pending.preparation.done))
        ) {
          stopped = true;
          return yield* Effect.die("process exited at root preparation publication");
        }
      }),
  };
  const exit = yield* Effect.exit(
    Effect.gen(function* () {
      const library = yield* Library.Service;
      return yield* library.setup(f.steps, { base: yield* library.read });
    }).pipe(
      Effect.provide(f.layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, files)))),
    ),
  );
  assert.strictEqual(exit._tag, "Failure");
  assert.isTrue(stopped);
  const state = yield* decode(yield* f.fs.readFileString(f.state));
  assert.deepStrictEqual(state.collections, []);
  const pending = state.operations.find((operation) => operation._tag === "Pending");
  assert.strictEqual(pending?._tag, "Pending");
  if (pending?._tag !== "Pending") return yield* Effect.die("Missing durable attempt");
  return pending.operationId;
});

for (const boundary of ["recorded", "directory", "prepared"] as const)
  it.effect(`replays fixed root preparation after interruption at ${boundary}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const id = yield* interrupt(f, boundary);
      for (let attempt = 0; attempt < 2; attempt++) {
        yield* Effect.gen(function* () {
          const library = yield* Library.Service;
          assert.deepStrictEqual(library.startup.stopped, []);
          const history = yield* library.history;
          const operation = history.operations.find((operation) => operation.operationId === id);
          assert.strictEqual(operation?._tag, "Done");
          assert.isFalse(Object.hasOwn(operation ?? {}, "preparation"));
          assert.isTrue(operation?.steps.every((step) => step.status === "Done"));
          assert.strictEqual(history.events.length, 1);
          const snapshot = yield* library.read;
          assert.strictEqual(snapshot._tag, "Present");
          if (snapshot._tag === "Present") assert.strictEqual(snapshot.state.collections.length, 1);
        }).pipe(Effect.provide(f.layer));
        assert.strictEqual(
          yield* f.fs.readFileString(join(f.claude, "review", "SKILL.md")),
          f.bytes,
        );
        assert.strictEqual(yield* f.fs.readFileString(join(f.source, "SKILL.md")), f.bytes);
      }
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

for (const boundary of ["recorded", "prepared"] as const)
  it.effect(`preserves a redirected root after the ${boundary} checkpoint`, () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* interrupt(f, boundary);
      const foreign = join(f.root, "foreign");
      yield* f.fs.makeDirectory(foreign);
      yield* f.fs.writeFileString(join(foreign, "user.txt"), "User bytes\n");
      if (boundary === "prepared") yield* f.fs.rename(f.claude, f.claude + "-recorded");
      else yield* f.fs.makeDirectory(join(f.root, "claude"));
      yield* f.fs.symlink(foreign, f.claude);
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        assert.strictEqual(library.startup.stopped.length, 1);
        assert.strictEqual(library.startup.stopped[0]?.reason._tag, "EvidenceDiffers");
        const snapshot = yield* library.read;
        if (snapshot._tag !== "Present") return yield* Effect.die("Missing attempt");
        assert.deepStrictEqual(snapshot.state.collections, []);
      }).pipe(Effect.provide(f.layer));
      assert.strictEqual(yield* f.fs.readFileString(join(foreign, "user.txt")), "User bytes\n");
      assert.deepStrictEqual(yield* f.fs.readDirectory(foreign), ["user.txt"]);
      assert.strictEqual(yield* f.fs.readFileString(join(f.source, "SKILL.md")), f.bytes);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("a stale Library base creates no destination or staging directories", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const base = yield* library.read;
      const first = f.steps[0];
      if (first._tag !== "Import") return yield* Effect.die("Missing import");
      yield* library.import.collection(first.request);
      const exit = yield* Effect.exit(library.setup(f.steps, { base }));
      assert.strictEqual(exit._tag, "Failure");
      assert.isFalse(yield* f.fs.exists(f.claude));
      assert.isFalse(yield* f.fs.exists(join(f.agents, ".skit-backups")));
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
