import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Schema } from "effect";
import { DatabaseSync } from "node:sqlite";
import { TestClock } from "effect/testing";
import { dirname, join } from "node:path";
import * as History from "@smolai/skit-core/history";
import {
  readAuthorAncestors,
  readAuthorRevision,
} from "../src/platform/author-sync-fixture/history.js";
import { makeAuthorSyncWorld } from "../src/platform/author-sync-fixture/world.js";
import {
  authorLayer,
  readAuthorTree,
  refreshWorkspace,
  storedTreesAt,
} from "../src/platform/author-sync-fixture/history.js";
import { testPlatformLayer } from "./helpers/platform.js";

/** Capture `workspace` through its own owners over `home`. */
const capture = (workspace: string, home: string) =>
  refreshWorkspace(workspace).pipe(Effect.provide(authorLayer(home)));

const nativeTreeCount = Effect.fn("Test.nativeTreeCount")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = join(home, "library.sqlite");
  if (!(yield* fs.exists(path))) return 0;
  const row = yield* Effect.try({
    try: () => {
      const sql = new DatabaseSync(path, { readOnly: true });
      try {
        return sql.prepare("SELECT name FROM sqlite_master WHERE name='author_trees'").get()
          ? sql.prepare("SELECT COUNT(*) AS count FROM author_trees").get()
          : { count: 0 };
      } finally {
        sql.close();
      }
    },
    catch: (cause) => new History.StoreFailed({ cause }),
  });
  return (yield* Schema.decodeUnknownEffect(Schema.Struct({ count: Schema.Int }))(row)).count;
});

/** The ids reachable from `id` in `home`'s history, newest first. */
const lineage = (id: History.RevisionId, home: string) =>
  Effect.gen(function* () {
    const reached = yield* readAuthorAncestors(home, id);
    return Array.from(reached, (entry) => entry.id);
  }).pipe(Effect.provide(authorLayer(home)));

const fileText = (tree: History.Tree, path: string) => {
  const file = tree.find((entry) => entry.path === path);
  return file?.kind === "file" ? Buffer.from(file.bytes).toString() : undefined;
};

it.effect("A → B → A records three ordered revisions referencing two stored trees", () =>
  Effect.gen(function* () {
    const { a } = yield* makeAuthorSyncWorld();
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      yield* a.edit("notes/a.txt", "A");
      const first = yield* refreshWorkspace(a.workspace);
      yield* a.edit("notes/a.txt", "B");
      const second = yield* refreshWorkspace(a.workspace);
      // Equal times above and a backwards wall clock below cannot reorder revisions.
      yield* TestClock.setTime(500);
      yield* a.edit("notes/a.txt", "A");
      const third = yield* refreshWorkspace(a.workspace);
      const observations = [first, second, third];
      expect(observations.map((saved) => saved.revision.author.at)).toEqual([1000, 1000, 500]);
      expect(observations.map((saved) => saved.revision.tree)).toEqual([
        first.treeHash,
        second.treeHash,
        first.treeHash,
      ]);
      expect(observations.map((saved) => saved.revision.parents)).toEqual([
        [],
        [first.id],
        [second.id],
      ]);
      expect(new Set(observations.map((saved) => saved.id)).size).toBe(3);
      expect(third.treeHash).toBe(first.treeHash);
      expect(yield* storedTreesAt(a.home)).toHaveLength(2);
      expect(fileText(yield* readAuthorTree(second, a.home), "notes/a.txt")).toBe("B");
      expect(new Set(observations.map((saved) => saved.revision.author.device)).size).toBe(1);
      // The latest is still the third: an unchanged capture records nothing.
      expect((yield* refreshWorkspace(a.workspace)).id).toBe(third.id);
    }).pipe(Effect.provide(authorLayer(a.home)));
    expect(yield* lineage((yield* capture(a.workspace, a.home)).id, a.home)).toHaveLength(3);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("unchanged concurrent observations add no duplicate events", () =>
  Effect.gen(function* () {
    const { a } = yield* makeAuthorSyncWorld();
    yield* a.edit("notes/a.txt", "unchanged");
    yield* Effect.gen(function* () {
      const first = yield* refreshWorkspace(a.workspace);
      const repeated = yield* Effect.all(
        Array.from({ length: 4 }, () => refreshWorkspace(a.workspace)),
        { concurrency: "unbounded" },
      );
      expect(repeated.map((saved) => saved.id)).toEqual(Array.from({ length: 4 }, () => first.id));
      expect(first.revision.parents).toEqual([]);
      expect(yield* storedTreesAt(a.home)).toHaveLength(1);
    }).pipe(Effect.provide(authorLayer(a.home)));
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("a pending B observation cannot be overtaken by an unchanged A scan", () =>
  Effect.gen(function* () {
    const { a } = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    const directory = join(a.home, "file-bytes");
    const entered = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    // Only the B capture pauses; both captures share this one layer's journal permit.
    let pausing = false;
    let beforeB = 0;
    yield* Effect.gen(function* () {
      yield* a.edit("notes/a.txt", "A");
      const first = yield* refreshWorkspace(a.workspace);
      beforeB = yield* nativeTreeCount(a.home);
      yield* a.edit("notes/a.txt", "B");
      pausing = true;
      const pendingB = yield* refreshWorkspace(a.workspace).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* a.edit("notes/a.txt", "A");
      const pendingA = yield* refreshWorkspace(a.workspace).pipe(Effect.forkScoped);
      yield* Deferred.succeed(released, undefined);
      const second = yield* Fiber.join(pendingB);
      const third = yield* Fiber.join(pendingA);
      expect(second.revision.parents).toEqual([first.id]);
      expect(third.revision.parents).toEqual([second.id]);
      expect(second.treeHash).not.toBe(first.treeHash);
      expect(third.treeHash).toBe(first.treeHash);
      expect((yield* refreshWorkspace(a.workspace)).id).toBe(third.id);
    }).pipe(
      Effect.provide(authorLayer(a.home)),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readFile: Effect.fn("Test.pauseBeforeObservationCommit")(function* (path) {
          const content = yield* fs.readFile(path);
          if (
            pausing &&
            dirname(path) === directory &&
            (yield* nativeTreeCount(a.home).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.orDie,
            )) > beforeB
          ) {
            pausing = false;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(released);
          }
          return content;
        }),
      }),
    );
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
      const directory = join(a.home, "file-bytes");
      yield* TestClock.setTime(1000);
      const pending = yield* refreshWorkspace(a.workspace).pipe(
        Effect.provide(authorLayer(a.home)),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFile: Effect.fn("Test.pauseRecordedTreeBeforeCommit")(function* (path) {
            const content = yield* fs.readFile(path);
            if (
              dirname(path) === directory &&
              (yield* nativeTreeCount(a.home).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.orDie,
              )) > 0
            ) {
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.never;
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
      expect(yield* storedTreesAt(a.home)).toHaveLength(1);
      // A committed event would make this unchanged capture return the interrupted revision.
      yield* TestClock.setTime(2000);
      const recovered = yield* capture(a.workspace, a.home);
      expect(recovered.revision.parents).toEqual([]);
      expect(recovered.revision.author.at).toBe(2000);
      expect((yield* capture(a.workspace, a.home)).id).toBe(recovered.id);
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "retry after a committed observation loses its acknowledgement adds no duplicate event",
  () =>
    Effect.gen(function* () {
      const { a } = yield* makeAuthorSyncWorld();
      const fs = yield* FileSystem.FileSystem;
      const directory = join(a.home, "history");
      const database = join(a.home, "library.sqlite");
      const eventCount = () => {
        const sql = new DatabaseSync(database, { readOnly: true });
        try {
          if (
            !sql.prepare("SELECT name FROM sqlite_master WHERE name='author_history_events'").get()
          )
            return 0;
          return Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }))(
            sql.prepare("SELECT COUNT(*) AS count FROM author_history_events").get(),
          ).count;
        } finally {
          sql.close();
        }
      };
      const beforeCount = (yield* fs.exists(database)) ? eventCount() : 0;
      yield* a.edit("notes/a.txt", "accepted observation");
      yield* TestClock.setTime(1000);
      let interrupted = false;
      const failed = yield* Effect.result(
        refreshWorkspace(a.workspace).pipe(
          Effect.provide(authorLayer(a.home)),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            open: Effect.fn("Test.failObservationAcknowledgement")(function* (path, options) {
              // An independent connection proves the new event committed before acknowledgement.
              if (
                path === directory &&
                !interrupted &&
                (yield* fs.exists(database)) &&
                eventCount() > beforeCount
              ) {
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
      // The retry finds the committed revision rather than recording a second one.
      yield* TestClock.setTime(2000);
      const retried = yield* capture(a.workspace, a.home);
      expect(retried.revision.parents).toEqual([]);
      expect(retried.revision.author.at).toBe(1000);
      expect((yield* capture(a.workspace, a.home)).id).toBe(retried.id);
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("history is kept per workspace", () =>
  Effect.gen(function* () {
    const { a, b } = yield* makeAuthorSyncWorld();
    yield* Effect.gen(function* () {
      yield* a.edit("notes/a.txt", "A");
      const first = yield* refreshWorkspace(a.workspace);
      yield* b.edit("notes/b.txt", "B");
      const other = yield* refreshWorkspace(b.workspace);
      yield* a.edit("notes/a.txt", "A2");
      const second = yield* refreshWorkspace(a.workspace);
      expect(first.revision.parents).toEqual([]);
      expect(other.revision.parents).toEqual([]);
      expect(second.revision.parents).toEqual([first.id]);
      expect((yield* refreshWorkspace(b.workspace)).id).toBe(other.id);
    }).pipe(Effect.provide(authorLayer(a.home)));
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "adding workspace identity and then moving its folder preserves chronological history",
  () =>
    Effect.gen(function* () {
      const { a } = yield* makeAuthorSyncWorld();
      const fs = yield* FileSystem.FileSystem;
      yield* Effect.gen(function* () {
        yield* a.edit("notes/a.txt", "before registration");
        const first = yield* refreshWorkspace(a.workspace);
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
        const second = yield* refreshWorkspace(a.workspace);
        const moved = join(dirname(a.workspace), "moved");
        yield* fs.rename(a.workspace, moved);
        yield* fs.writeFileString(join(moved, "notes/a.txt"), "after move");
        const third = yield* refreshWorkspace(moved);
        expect([first, second, third].map((saved) => saved.revision.parents)).toEqual([
          [],
          [first.id],
          [second.id],
        ]);
        // The old path can now belong to a different, anonymous workspace.
        yield* fs.makeDirectory(a.workspace);
        yield* fs.writeFileString(join(a.workspace, "fresh.txt"), "independent");
        const fresh = yield* refreshWorkspace(a.workspace);
        expect(fresh.revision.parents).toEqual([]);
        expect((yield* refreshWorkspace(moved)).id).toBe(third.id);
      }).pipe(Effect.provide(authorLayer(a.home)));
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
    yield* Effect.gen(function* () {
      const original = yield* refreshWorkspace(a.workspace);
      expect(yield* Effect.flip(refreshWorkspace(b.workspace))).toMatchObject({
        _tag: "AuthorWorkspaceAlreadyRegistered",
        at: yield* fs.realPath(a.workspace),
      });
      expect((yield* refreshWorkspace(a.workspace)).id).toBe(original.id);
    }).pipe(Effect.provide(authorLayer(a.home)));
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("existing stored trees stay available without inventing a pre-journal timeline", () =>
  Effect.gen(function* () {
    const { a } = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    yield* a.edit("notes/a.txt", "existing tree");
    const saved = yield* capture(a.workspace, a.home);
    // A home with immutable history files but no journal has no earlier timeline to infer.
    const preJournalHome = join(a.home, "pre-journal");
    yield* fs.makeDirectory(preJournalHome);
    yield* fs.copy(join(a.home, "history"), join(preJournalHome, "history"));
    yield* fs.makeDirectory(join(preJournalHome, "history", "trees"), { recursive: true });
    yield* fs.writeFileString(
      join(preJournalHome, "history", "trees", `${saved.treeHash.slice(7)}.json`),
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(History.Tree)))(
        yield* readAuthorTree(saved, a.home),
      ),
    );
    yield* fs.remove(join(preJournalHome, "history", "journal.sqlite"));
    yield* fs.remove(join(preJournalHome, "history", "lock.sqlite"));
    yield* Effect.gen(function* () {
      expect(fileText(yield* readAuthorTree(saved, preJournalHome), "notes/a.txt")).toBe(
        "existing tree",
      );
      yield* TestClock.setTime(1000);
      const recorded = yield* refreshWorkspace(a.workspace);
      expect(recorded.treeHash).toBe(saved.treeHash);
      expect(recorded.revision.parents).toEqual([]);
      expect(recorded.revision.author.at).toBe(1000);
      expect(yield* storedTreesAt(preJournalHome)).toHaveLength(1);
    }).pipe(Effect.provide(authorLayer(preJournalHome)));
  }).pipe(Effect.provide(testPlatformLayer)),
);

describe("skit author sync", () => {
  describe("Keeping saved work", () => {
    describe("Versions recorded by SKIT remain recoverable after sync.", () => {
      it.effect(
        "sync records its own remote applications so A → B → A retains all three observations",
        () =>
          Effect.gen(function* () {
            const world = yield* makeAuthorSyncWorld();
            yield* world.connect();
            const before = yield* capture(world.a.workspace, world.a.home);
            yield* world.a.edit("notes/a.txt", "A");
            yield* world.a.sync();
            yield* world.b.sync();
            yield* world.b.edit("notes/a.txt", "B");
            yield* world.b.sync();
            yield* world.a.sync();
            yield* world.b.edit("notes/a.txt", "A");
            yield* world.b.sync();
            yield* world.a.sync();
            const after = yield* capture(world.a.workspace, world.a.home);
            const ids = yield* lineage(after.id, world.a.home);
            const since = ids.slice(0, ids.indexOf(before.id)).reverse();
            expect(since).toHaveLength(3);
            yield* Effect.gen(function* () {
              const revisions = yield* Effect.forEach(since, (id) =>
                readAuthorRevision(world.a.home, id),
              );
              expect(revisions[0]?.tree).toBe(revisions[2]?.tree);
              const contents: Array<string | undefined> = [];
              for (const revision of revisions)
                contents.push(
                  fileText(
                    yield* readAuthorTree({ treeHash: revision.tree }, world.a.home),
                    "notes/a.txt",
                  ),
                );
              expect(contents).toEqual(["A", "B", "A"]);
            }).pipe(Effect.provide(authorLayer(world.a.home)));
          }).pipe(Effect.provide(testPlatformLayer)),
      );
    });
  });
});
