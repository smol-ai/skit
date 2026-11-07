import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Result } from "effect";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { holdHomeLock } from "./helpers/home-lock.js";
import { readAuthorAncestors } from "./helpers/author-history.js";
import {
  authorLayer,
  refreshWorkspace,
  capturedTree,
  storedTrees,
  storedTreesAt,
} from "./helpers/author-history.js";
import { makeAuthorSyncWorld } from "./helpers/author-sync-world.js";
import { testPlatformLayer } from "./helpers/platform.js";

it.effect("ignored edits neither enter raw history nor record a new revision", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.sync(() => execFileSync("git", ["init", "--quiet", world.a.workspace]));
    yield* fs.writeFileString(join(world.a.workspace, ".gitignore"), "*.local\n");
    yield* fs.writeFileString(join(world.a.workspace, "private.local"), "first ignored value\n");
    yield* Effect.gen(function* () {
      const before = yield* refreshWorkspace(world.a.workspace);
      yield* fs.writeFileString(join(world.a.workspace, "private.local"), "second ignored value\n");
      const after = yield* refreshWorkspace(world.a.workspace);
      expect(after.treeHash).toBe(before.treeHash);
      // The same revision: the unchanged capture recorded nothing.
      expect(after.id).toBe(before.id);
      expect(after.revision.parents).toEqual([]);
      expect(
        (yield* capturedTree(after, world.a.home)).some((entry) => entry.path === "private.local"),
      ).toBe(false);
      const versions = yield* storedTrees(world.a.home);
      expect(versions).toHaveLength(1);
      expect(versions[0]?.tree.some((entry) => entry.path === "private.local")).toBe(false);
    }).pipe(Effect.provide(authorLayer(world.a.home)));
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("backs up invalid descriptor bytes locally and online without refusing sync", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    yield* world.connect();
    const remoteBefore = (yield* world.server.currentHistory()).length;
    yield* world.a.edit("skit.json", "{unfinished descriptor", "remote");
    expect((yield* world.a.sync()).status).toBe("pushed");
    expect(yield* world.missing(yield* world.copies())).toEqual([]);
    expect((yield* world.server.currentHistory()).length).toBe(remoteBefore + 1);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("a preview saves what it observed but sends nothing", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    yield* world.connect();
    const remoteBefore = yield* world.server.revisions();
    yield* world.a.edit("notes/a.txt", "preview only\n", "local-history");
    expect(yield* world.a.preview()).toMatchObject({ status: "ready", action: "push" });
    expect(yield* world.missing(yield* world.copies())).toEqual([]);
    expect(yield* world.server.revisions()).toEqual(remoteBefore);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "concurrent recordings publish one readable immutable version with private permissions",
  () =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      const fs = yield* FileSystem.FileSystem;
      yield* world.a.edit("notes/a.txt", "one stable tree\n", "local-history");
      // One runtime, as the CLI has: both recordings share the home's journal permit.
      const { versions, stored } = yield* Effect.gen(function* () {
        const versions = yield* Effect.all(
          [refreshWorkspace(world.a.workspace), refreshWorkspace(world.a.workspace)],
          { concurrency: "unbounded" },
        );
        return { versions, stored: yield* storedTrees(world.a.home) };
      }).pipe(Effect.provide(authorLayer(world.a.home)));
      expect(versions[0].treeHash).toBe(versions[1].treeHash);
      expect(versions[0].id).toBe(versions[1].id);
      expect(stored).toHaveLength(1);
      for (const version of stored) {
        const path = join(world.a.home, "history", "trees", `${version.hash.slice(7)}.json`);
        expect((yield* fs.stat(path)).mode & 0o777).toBe(0o600);
      }
      expect((yield* fs.stat(join(world.a.home, "history"))).mode & 0o777).toBe(0o700);
      expect(yield* world.missing(yield* world.copies())).toEqual([]);
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("retries a tree that changes between reads instead of recording a mixed version", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    yield* world.a.edit("notes/a.txt", "before\n");
    const path = yield* fs.realPath(join(world.a.workspace, "notes/a.txt"));
    let reads = 0;
    yield* refreshWorkspace(world.a.workspace).pipe(
      Effect.provide(authorLayer(world.a.home)),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readFile: Effect.fn("Test.changeDuringHistoryRead")(function* (input) {
          const bytes = yield* fs.readFile(input);
          if (input === path) {
            reads++;
            if (reads === 1) yield* fs.writeFileString(path, "after\n");
          }
          return bytes;
        }),
      }),
    );
    expect(reads).toBe(4);
    const stored = yield* storedTreesAt(world.a.home);
    expect(stored).toHaveLength(1);
    const file = stored[0]?.tree.find((entry) => entry.path === "notes/a.txt");
    expect(file?.kind).toBe("file");
    if (file?.kind === "file") expect(Buffer.from(file.bytes).toString()).toBe("after\n");
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "keeps binary bytes, executable modes and symlinks without interpreting skill validity",
  () =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      const fs = yield* FileSystem.FileSystem;
      yield* world.a.edit("notes/run.sh", "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(join(world.a.workspace, "notes/run.sh"), 0o755);
      yield* fs.symlink("run.sh", join(world.a.workspace, "notes/link"));
      yield* fs.writeFile(join(world.a.workspace, "notes/binary"), new Uint8Array([0, 128, 255]));
      const tree = yield* refreshWorkspace(world.a.workspace).pipe(
        Effect.flatMap((observation) => capturedTree(observation, world.a.home)),
        Effect.provide(authorLayer(world.a.home)),
      );
      expect(tree.find((entry) => entry.path === "notes/run.sh")).toMatchObject({
        kind: "file",
        mode: 0o755,
      });
      expect(tree.find((entry) => entry.path === "notes/link")).toEqual({
        kind: "symlink",
        path: "notes/link",
        target: "run.sh",
      });
      const binary = tree.find((entry) => entry.path === "notes/binary");
      expect(binary?.kind).toBe("file");
      if (binary?.kind === "file") expect(Array.from(binary.bytes)).toEqual([0, 128, 255]);
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "corrupt history fails verification and cannot be silently replaced by another recording",
  () =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      const fs = yield* FileSystem.FileSystem;
      yield* Effect.gen(function* () {
        const version = yield* refreshWorkspace(world.a.workspace);
        const path = join(world.a.home, "history", "trees", `${version.treeHash.slice(7)}.json`);
        yield* fs.writeFileString(path, "corrupted");
        expect(yield* Effect.flip(storedTrees(world.a.home))).toMatchObject({
          _tag: "History.StoreCorrupt",
        });
        expect(yield* Effect.flip(refreshWorkspace(world.a.workspace))).toMatchObject({
          _tag: "AuthorHistoryInvalid",
        });
        expect(yield* fs.readFileString(path)).toBe("corrupted");
      }).pipe(Effect.provide(authorLayer(world.a.home)));
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("storage failure stops sync before contacting the remote", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(join(world.a.home, "history"), "occupied");
    expect(Result.isFailure(yield* Effect.result(world.a.sync(true)))).toBe(true);
    expect(yield* world.server.events()).toEqual([]);
    expect(yield* world.server.revisions()).toEqual([]);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("rejects a history home inside its workspace before creating it", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    const home = join(world.a.workspace, "nested-history");
    expect(
      yield* Effect.flip(refreshWorkspace(world.a.workspace)).pipe(
        Effect.provide(authorLayer(home)),
      ),
    ).toMatchObject({ _tag: "AuthorHistoryInvalid" });
    expect(yield* fs.exists(home)).toBe(false);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("rejects a history directory symlink into its workspace", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    const before = (yield* fs.readDirectory(world.a.workspace)).sort();
    yield* fs.symlink(world.a.workspace, join(world.a.home, "history"));
    expect(
      yield* Effect.flip(refreshWorkspace(world.a.workspace)).pipe(
        Effect.provide(authorLayer(world.a.home)),
      ),
    ).toMatchObject({ _tag: "AuthorHistoryInvalid" });
    expect((yield* fs.readDirectory(world.a.workspace)).sort()).toEqual(before);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "rejects a dangling journal symlink before SQLite can create a database in the source",
  () =>
    Effect.gen(function* () {
      const { a } = yield* makeAuthorSyncWorld();
      const fs = yield* FileSystem.FileSystem;
      const directory = join(a.home, "history");
      const target = join(a.workspace, "journal.sqlite");
      yield* fs.makeDirectory(directory);
      yield* fs.symlink(target, join(directory, "journal.sqlite"));
      expect(
        yield* Effect.flip(refreshWorkspace(a.workspace)).pipe(Effect.provide(authorLayer(a.home))),
      ).toMatchObject({ _tag: "AuthorHistoryInvalid" });
      expect(yield* fs.exists(target)).toBe(false);
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "uses valid workspace identity and still backs up files when device metadata is malformed",
  () =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      const fs = yield* FileSystem.FileSystem;
      const metadata = join(world.a.workspace, ".skit", "workspace.json");
      yield* fs.makeDirectory(join(world.a.workspace, ".skit"));
      const workspaceId = `workspace_${"a".repeat(32)}`;
      yield* fs.writeFileString(
        metadata,
        JSON.stringify({ schema: "skit.author-workspace.v1", workspace_id: workspaceId }),
      );
      yield* Effect.gen(function* () {
        const first = yield* refreshWorkspace(world.a.workspace);
        // The identity was recorded: a live copy carrying it is refused under that identity.
        const copy = join(world.a.home, "copy");
        yield* fs.copy(world.a.workspace, copy);
        expect(yield* Effect.flip(refreshWorkspace(copy))).toMatchObject({
          _tag: "AuthorWorkspaceAlreadyRegistered",
          workspaceId,
        });
        yield* fs.writeFileString(metadata, "unfinished metadata");
        yield* world.a.edit("notes/a.txt", "after the metadata broke\n");
        const version = yield* refreshWorkspace(world.a.workspace);
        // Recorded on the same history, after the revision made under the valid identity.
        expect(version.revision.parents).toEqual([first.id]);
        const tree = yield* capturedTree(version, world.a.home);
        expect(tree.some((entry) => entry.path === "notes/a.txt")).toBe(true);
        expect(tree.some((entry) => entry.path.startsWith(".skit/"))).toBe(false);
        const history = yield* readAuthorAncestors(world.a.home, version.id);
        expect(history.map((entry) => entry.id)).toEqual([version.id, first.id]);
      }).pipe(Effect.provide(authorLayer(world.a.home)));
      expect(yield* fs.readFileString(metadata)).toBe("unfinished metadata");
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("capture reports shared HomeBusy when machine identity cannot be written", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-capture-home-busy-" });
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    yield* fs.makeDirectory(home);
    yield* fs.makeDirectory(workspace);
    yield* fs.writeFileString(
      join(workspace, "SKILL.md"),
      "---\nname: review\ndescription: review\n---\nReview\n",
    );
    yield* holdHomeLock(home);
    const error = yield* refreshWorkspace(workspace).pipe(
      Effect.provide(authorLayer(home)),
      Effect.flip,
    );
    expect(error).toMatchObject({
      _tag: "HomeBusy",
      code: "CONFLICT",
      path: join(home, "lock.sqlite"),
    });
    expect(yield* fs.exists(join(home, "machine.json"))).toBe(false);
    expect(yield* fs.exists(join(home, "state.json"))).toBe(false);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
