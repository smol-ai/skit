import { expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Path } from "effect";
import { Digest } from "effect/crypto";
import { TestClock } from "effect/testing";
import { dirname, join } from "node:path";
import {
  loadAuthorHistory,
  loadAuthorTree,
  loadStoredTrees,
  refreshAuthorHistory,
} from "../src/workflows/author/history.js";
import { makeAuthorSyncWorld } from "./helpers/author-sync-world.js";
import { testPlatformLayer } from "./helpers/platform.js";
import { SkitConfiguration } from "../src/configuration/skit-configuration.js";

it.effect("A → B → A records three ordered revisions referencing two stored trees", () =>
  Effect.gen(function* () {
    const { a } = yield* makeAuthorSyncWorld();
    yield* TestClock.setTime(1000);
    yield* a.edit("notes/a.txt", "A");
    const first = yield* refreshAuthorHistory(a.workspace, a.home);
    yield* a.edit("notes/a.txt", "B");
    const second = yield* refreshAuthorHistory(a.workspace, a.home);
    // Equal times above and a backwards wall clock below cannot reorder revisions.
    yield* TestClock.setTime(500);
    yield* a.edit("notes/a.txt", "A");
    const third = yield* refreshAuthorHistory(a.workspace, a.home);
    const events = yield* loadAuthorHistory(a.workspace, a.home);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.revision.author.at)).toEqual([1000, 1000, 500]);
    expect(events.map((event) => event.revision.tree)).toEqual([
      first.treeHash,
      second.treeHash,
      first.treeHash,
    ]);
    expect(events.map((event) => event.id)).toEqual([first.id, second.id, third.id]);
    expect(events.map((event) => event.revision.parents)).toEqual([[], [first.id], [second.id]]);
    expect(third.treeHash).toBe(first.treeHash);
    expect(yield* loadStoredTrees(a.home)).toHaveLength(2);
    const previous = events.at(-2);
    expect(previous).toBeDefined();
    if (previous) {
      const tree = yield* loadAuthorTree(previous.revision.tree, a.home);
      const file = tree.find((entry) => entry.path === "notes/a.txt");
      expect(file?.kind).toBe("file");
      if (file?.kind === "file") expect(Buffer.from(file.bytes).toString()).toBe("B");
    }
    expect(new Set(events.map((event) => event.revision.author.device)).size).toBe(1);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("unchanged concurrent observations add no duplicate events", () =>
  Effect.gen(function* () {
    const { a } = yield* makeAuthorSyncWorld();
    yield* a.edit("notes/a.txt", "unchanged");
    yield* refreshAuthorHistory(a.workspace, a.home);
    yield* Effect.all(
      Array.from({ length: 4 }, () => refreshAuthorHistory(a.workspace, a.home)),
      { concurrency: "unbounded" },
    );
    expect(yield* loadAuthorHistory(a.workspace, a.home)).toHaveLength(1);
    expect(yield* loadStoredTrees(a.home)).toHaveLength(1);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "sync records its own remote applications so A → B → A retains all three observations",
  () =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      yield* world.connect();
      const before = (yield* loadAuthorHistory(world.a.workspace, world.a.home)).length;
      yield* world.a.edit("notes/a.txt", "A");
      yield* world.a.sync();
      yield* world.b.sync();
      yield* world.b.edit("notes/a.txt", "B");
      yield* world.b.sync();
      yield* world.a.sync();
      yield* world.b.edit("notes/a.txt", "A");
      yield* world.b.sync();
      yield* world.a.sync();
      const events = (yield* loadAuthorHistory(world.a.workspace, world.a.home)).slice(before);
      expect(events).toHaveLength(3);
      expect(events[0]?.revision.tree).toBe(events[2]?.revision.tree);
      const contents: string[] = [];
      for (const event of events) {
        const tree = yield* loadAuthorTree(event.revision.tree, world.a.home);
        const file = tree.find((entry) => entry.path === "notes/a.txt");
        expect(file?.kind).toBe("file");
        if (file?.kind === "file") contents.push(Buffer.from(file.bytes).toString());
      }
      expect(contents).toEqual(["A", "B", "A"]);
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("a pending B observation cannot be overtaken by an unchanged A scan", () =>
  Effect.gen(function* () {
    const { a } = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    yield* a.edit("notes/a.txt", "A");
    const first = yield* refreshAuthorHistory(a.workspace, a.home);
    const directory = join(a.home, "history", "trees");
    const entered = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    yield* a.edit("notes/a.txt", "B");
    const pendingB = yield* refreshAuthorHistory(a.workspace, a.home).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readFileString: Effect.fn("Test.pauseBeforeObservationCommit")(function* (path) {
          const content = yield* fs.readFileString(path);
          if (
            dirname(path) === directory &&
            path.endsWith(".json") &&
            !path.endsWith(`${first.treeHash.slice(7)}.json`)
          ) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(released);
          }
          return content;
        }),
      }),
      Effect.forkScoped,
    );
    yield* Deferred.await(entered);
    yield* a.edit("notes/a.txt", "A");
    const pendingA = yield* refreshAuthorHistory(a.workspace, a.home).pipe(Effect.forkScoped);
    expect(yield* loadAuthorHistory(a.workspace, a.home)).toHaveLength(1);
    yield* Deferred.succeed(released, undefined);
    const second = yield* Fiber.join(pendingB);
    yield* Fiber.join(pendingA);
    expect(
      (yield* loadAuthorHistory(a.workspace, a.home)).map((event) => event.revision.tree),
    ).toEqual([first.treeHash, second.treeHash, first.treeHash]);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "interruption before journal commit leaves recoverable content but no phantom event",
  () =>
    Effect.gen(function* () {
      const { a } = yield* makeAuthorSyncWorld();
      const fs = yield* FileSystem.FileSystem;
      yield* a.edit("notes/a.txt", "record me");
      const entered = yield* Deferred.make<void>();
      const directory = join(a.home, "history", "trees");
      const pending = yield* refreshAuthorHistory(a.workspace, a.home).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: Effect.fn("Test.pauseRecordedTreeBeforeCommit")(function* (path) {
            const content = yield* fs.readFileString(path);
            if (dirname(path) === directory && path.endsWith(".json")) {
              yield* Deferred.succeed(entered, undefined);
              yield* Effect.never;
            }
            return content;
          }),
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(pending);
      const exit = yield* Effect.exit(Fiber.join(pending));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(yield* loadAuthorHistory(a.workspace, a.home)).toEqual([]);
      expect(yield* loadStoredTrees(a.home)).toHaveLength(1);
      yield* refreshAuthorHistory(a.workspace, a.home);
      expect(
        (yield* loadAuthorHistory(a.workspace, a.home)).map((event) => event.sequence),
      ).toEqual([1]);
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "retry after a committed observation loses its acknowledgement adds no duplicate event",
  () =>
    Effect.gen(function* () {
      const { a } = yield* makeAuthorSyncWorld();
      const fs = yield* FileSystem.FileSystem;
      const directory = join(a.home, "history");
      yield* a.edit("notes/a.txt", "accepted observation");
      const committed = loadAuthorHistory(a.workspace, a.home).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(SkitConfiguration, yield* SkitConfiguration),
        Effect.provideService(Digest.Digest, yield* Digest.Digest),
        Effect.provideService(Path.Path, yield* Path.Path),
        Effect.orDie,
      );
      let interrupted = false;
      const failed = yield* Effect.result(
        refreshAuthorHistory(a.workspace, a.home).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            open: Effect.fn("Test.failObservationAcknowledgement")(function* (path, options) {
              if (path === directory && !interrupted && (yield* committed).length === 1) {
                interrupted = true;
                return yield* fs.open(join(a.home, "missing"), options);
              }
              return yield* fs.open(path, options);
            }),
          }),
        ),
      );
      expect(failed._tag).toBe("Failure");
      expect(interrupted).toBe(true);
      expect(yield* loadAuthorHistory(a.workspace, a.home)).toHaveLength(1);
      yield* refreshAuthorHistory(a.workspace, a.home);
      expect(yield* loadAuthorHistory(a.workspace, a.home)).toHaveLength(1);
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("history listings are per workspace and do not decode retained tree contents", () =>
  Effect.gen(function* () {
    const { a, b } = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    yield* a.edit("notes/a.txt", "A");
    yield* refreshAuthorHistory(a.workspace, a.home);
    yield* b.edit("notes/b.txt", "B");
    yield* refreshAuthorHistory(b.workspace, a.home);
    yield* a.edit("notes/a.txt", "A2");
    yield* refreshAuthorHistory(a.workspace, a.home);
    const events = yield* loadAuthorHistory(a.workspace, a.home).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readFileString: (path) =>
          dirname(path) === join(a.home, "history", "trees") && path.endsWith(".json")
            ? Effect.die(new Error("History listing tried to read content"))
            : fs.readFileString(path),
      }),
    );
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect((yield* loadAuthorHistory(b.workspace, a.home)).map((event) => event.sequence)).toEqual([
      1,
    ]);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "adding workspace identity and then moving its folder preserves chronological history",
  () =>
    Effect.gen(function* () {
      const { a } = yield* makeAuthorSyncWorld();
      const fs = yield* FileSystem.FileSystem;
      yield* a.edit("notes/a.txt", "before registration");
      yield* refreshAuthorHistory(a.workspace, a.home);
      yield* fs.makeDirectory(join(a.workspace, ".skit"));
      yield* fs.writeFileString(
        join(a.workspace, ".skit", "workspace.json"),
        JSON.stringify({
          schema: "skit.author-workspace.v1",
          workspace_id: `workspace_${"a".repeat(32)}`,
        }),
      );
      // Workspace metadata is not part of the tree; each step edits a file so it saves a revision.
      yield* a.edit("notes/a.txt", "after registration");
      yield* refreshAuthorHistory(a.workspace, a.home);
      const moved = join(dirname(a.workspace), "moved");
      yield* fs.rename(a.workspace, moved);
      yield* fs.writeFileString(join(moved, "notes/a.txt"), "after move");
      yield* refreshAuthorHistory(moved, a.home);
      const events = yield* loadAuthorHistory(moved, a.home);
      expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
      expect(events.map((event) => event.revision.parents)).toEqual([
        [],
        [events[0]?.id],
        [events[1]?.id],
      ]);
      // The old path can now belong to a different, anonymous workspace.
      yield* fs.makeDirectory(a.workspace);
      yield* fs.writeFileString(join(a.workspace, "fresh.txt"), "independent");
      yield* refreshAuthorHistory(a.workspace, a.home);
      const fresh = yield* loadAuthorHistory(a.workspace, a.home);
      expect(fresh.map((event) => event.sequence)).toEqual([1]);
      expect(fresh[0]?.revision.parents).toEqual([]);
      expect(yield* loadAuthorHistory(moved, a.home)).toEqual(events);
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("copied live workspace identity cannot merge two folders' histories", () =>
  Effect.gen(function* () {
    const { a, b } = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    const metadata = JSON.stringify({
      schema: "skit.author-workspace.v1",
      workspace_id: `workspace_${"b".repeat(32)}`,
    });
    for (const root of [a.workspace, b.workspace]) {
      yield* fs.makeDirectory(join(root, ".skit"));
      yield* fs.writeFileString(join(root, ".skit", "workspace.json"), metadata);
    }
    yield* refreshAuthorHistory(a.workspace, a.home);
    const original = yield* loadAuthorHistory(a.workspace, a.home);
    expect(yield* Effect.flip(refreshAuthorHistory(b.workspace, a.home))).toMatchObject({
      _tag: "AuthorWorkspaceAlreadyRegistered",
      at: yield* fs.realPath(a.workspace),
    });
    expect(yield* loadAuthorHistory(a.workspace, a.home)).toEqual(original);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("existing stored trees stay available without inventing a pre-journal timeline", () =>
  Effect.gen(function* () {
    const { a } = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    yield* a.edit("notes/a.txt", "existing tree");
    const saved = yield* refreshAuthorHistory(a.workspace, a.home);
    yield* fs.remove(join(a.home, "history", "journal.sqlite"));
    expect(yield* loadAuthorHistory(a.workspace, a.home)).toEqual([]);
    const file = (yield* loadAuthorTree(saved.treeHash, a.home)).find(
      (entry) => entry.path === "notes/a.txt",
    );
    expect(file?.kind === "file" ? Buffer.from(file.bytes).toString() : undefined).toBe(
      "existing tree",
    );
    yield* refreshAuthorHistory(a.workspace, a.home);
    expect(
      (yield* loadAuthorHistory(a.workspace, a.home)).map((event) => event.revision.tree),
    ).toEqual([saved.treeHash]);
  }).pipe(Effect.provide(testPlatformLayer)),
);
