import { expect, it } from "@effect/vitest";
import {
  Arbitrary,
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Result,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { type History, Sync } from "@smolai/skit-core";
import {
  loadAuthorHistory,
  loadStoredTrees,
  refreshAuthorHistory,
} from "../src/workflows/author/history.js";
import { testPlatformLayer } from "./helpers/platform.js";
import { makeAuthorSyncWorld } from "./helpers/author-sync-world.js";
import { makeAuthorSyncServer } from "./helpers/author-sync-server.js";

it.effect.each([
  "{unfinished",
  JSON.stringify({
    schema: "skit.sync-bindings.v3",
    skits: { "skit://registry.example/swyx/tools": { _tag: "Unknown" } },
  }),
])(
  "invalid saved sync state is recoverable without changing files or remote history (%s)",
  (invalid) =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      const fs = yield* FileSystem.FileSystem;
      yield* world.connect();
      const path = join(world.a.home, "sync-bindings.json");
      const saved = yield* fs.readFileString(path);
      const files = yield* world.a.files();
      const revisions = yield* world.server.revisions();
      yield* fs.writeFileString(path, invalid);
      const failure = yield* Effect.flip(world.a.sync());
      expect(failure).toMatchObject({
        _tag: "AuthorSyncStateInvalid",
        path,
        code: "OPERATION_FAILED",
      });
      expect(yield* fs.readFileString(path)).toBe(invalid);
      expect(yield* world.a.files()).toEqual(files);
      expect(yield* world.server.revisions()).toEqual(revisions);
      yield* fs.writeFileString(path, saved);
      expect((yield* world.a.sync()).status).toBe("up_to_date");
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect.each(["Idle", "Sending", "Writing"] as const)(
  "v2 recovery checkpoints keep their history and upgrade on the next save (%s)",
  (kind) =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      const fs = yield* FileSystem.FileSystem;
      yield* world.connect();
      const path = join(world.a.home, "sync-bindings.json");
      const current = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            skits: Schema.Record(Schema.String, Sync.SyncState),
          }),
        ),
      )(yield* fs.readFileString(path));
      const locator = "skit://registry.example/swyx/tools";
      const initial = current.skits[locator];
      if (initial?._tag !== "Idle" || initial.base === null)
        return yield* Effect.die("Expected connected Idle checkpoint");
      const revisions = yield* world.server.revisions();
      const revision = revisions.find((entry) => entry.id === initial.base);
      if (revision === undefined) return yield* Effect.die("Expected current revision");
      const state: Sync.SyncState =
        kind === "Idle"
          ? initial
          : kind === "Sending"
            ? { _tag: "Sending", base: initial.base, revision: initial.base }
            : {
                _tag: "Writing",
                base: initial.base,
                from: revision.revision.tree,
                to: revision.revision.tree,
                next: { _tag: "Idle", base: initial.base },
              };
      const legacy = JSON.stringify({
        schema: "skit.sync-bindings.v2",
        drafts: { [locator]: state },
      });
      yield* fs.writeFileString(path, legacy);
      yield* world.a.preview();
      expect(yield* fs.readFileString(path)).toBe(legacy);
      yield* world.a.edit("notes/migration.txt", "Edit after v2 checkpoint");
      yield* world.a.sync();
      yield* world.b.sync();
      expect(yield* world.b.read("notes/migration.txt")).toBe("Edit after v2 checkpoint");
      const currentId = yield* world.server.current();
      const synced = (yield* world.server.revisions()).find((entry) => entry.id === currentId);
      // Losing the v2 base would create a new root and a spurious merge here.
      expect(synced?.revision.parents).toEqual([initial.base]);
      const saved = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            schema: Schema.String,
            skits: Schema.Record(Schema.String, Sync.SyncState),
          }),
        ),
      )(yield* fs.readFileString(path));
      expect(saved.schema).toBe("skit.sync-bindings.v3");
      expect(saved.skits[locator]?._tag).toBe("Idle");
      expect((yield* world.server.revisions()).some((entry) => entry.id === initial.base)).toBe(
        true,
      );
    }).pipe(Effect.provide(testPlatformLayer)),
);

type World = Effect.Success<ReturnType<typeof makeAuthorSyncWorld>>;

/** The text of `path` in a stored tree, if the tree holds it as a file. */
const textAt = (tree: History.Tree, path: string) => {
  const entry = tree.find((candidate) => candidate.path === path);
  return entry?.kind === "file" ? Buffer.from(entry.bytes).toString() : undefined;
};

/** Whether any revision on the server holds `value` in a file's bytes. */
const remoteHolds = Effect.fn("Test.remoteHolds")(function* (world: World, value: string) {
  return (yield* world.server.revisions()).some(({ tree }) =>
    tree.some((entry) => entry.kind === "file" && Buffer.from(entry.bytes).includes(value)),
  );
});

it.effect.each(["file", "dangling-symlink"] as const)(
  "incoming files cannot replace an ignored local %s outside the recorded inventory",
  (kind) =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      const fs = yield* FileSystem.FileSystem;
      yield* Effect.sync(() => execFileSync("git", ["init", "--quiet", world.b.workspace]));
      yield* fs.writeFileString(join(world.b.workspace, ".git/info/exclude"), ".env\n");
      const privatePath = join(world.b.workspace, ".env");
      const privateValue = "DEVICE_PRIVATE_CREDENTIAL_SENTINEL";
      if (kind === "file") yield* fs.writeFileString(privatePath, privateValue);
      else yield* fs.symlink("missing-private-target", privatePath);
      yield* world.connect();
      yield* world.a.edit(".env", "remotely authored public configuration\n");
      yield* world.a.sync();
      yield* world.b.edit("notes/local.txt", "ordinary local edit waits safely\n");
      const current = yield* world.server.current();
      const result = yield* Effect.result(world.b.sync());
      if (kind === "file") expect(yield* fs.readFileString(privatePath)).toBe(privateValue);
      else expect(yield* fs.readLink(privatePath)).toBe("missing-private-target");
      expect(result).toMatchObject({
        failure: { _tag: "AuthorLocalPathNotObserved", path: ".env" },
      });
      expect(yield* world.server.current()).toBe(current);
      // A restart and retry keep the private path safe.
      yield* world.b.restart();
      expect(yield* Effect.result(world.b.sync())).toMatchObject({
        failure: { _tag: "AuthorLocalPathNotObserved" },
      });
      if (kind === "file") expect(yield* fs.readFileString(privatePath)).toBe(privateValue);
      else expect(yield* fs.readLink(privatePath)).toBe("missing-private-target");
      expect(yield* world.server.current()).toBe(current);
      expect(yield* remoteHolds(world, privateValue)).toBe(false);
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect.each(["atomic", "in-place"] as const)(
  "an %s editor save during directory preparation is preserved and merges cleanly",
  (kind) =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      const fs = yield* FileSystem.FileSystem;
      yield* world.connect();
      yield* world.a.edit("notes/a.txt", "base\n");
      yield* world.a.sync();
      yield* world.b.sync();
      yield* world.a.edit("notes/a.txt", "remote edit\n");
      yield* world.a.sync();
      let replaced = false;
      const result = yield* Effect.result(
        world.b.sync().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            makeDirectory: Effect.fn("Test.atomicEditorSaveBeforeRename")(
              function* (path, options) {
                yield* fs.makeDirectory(path, options);
                if (path === join(world.b.workspace, "notes") && !replaced) {
                  replaced = true;
                  if (kind === "atomic") {
                    const replacement = join(world.b.workspace, "notes/editor-save");
                    yield* fs.writeFileString(replacement, "editor save during apply\n");
                    yield* fs.rename(replacement, join(world.b.workspace, "notes/a.txt"));
                  } else
                    yield* fs.writeFileString(
                      join(world.b.workspace, "notes/a.txt"),
                      "editor save during apply\n",
                    );
                }
              },
            ),
          }),
        ),
      );
      expect(result).toMatchObject({
        failure: { _tag: "LocalFilesChangedDuringSync" },
      });
      expect(replaced).toBe(true);
      expect(yield* world.b.read("notes/a.txt")).toBe("editor save during apply\n");
      yield* world.b.restart();
      expect((yield* world.b.sync()).status).toBe("merged");
      yield* world.a.sync();
      expect(yield* world.a.read("notes/a.txt")).toBe("editor save during apply\n");
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "native non-NFC files can be sent, while receiving requires a real filesystem alias",
  () =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      const fs = yield* FileSystem.FileSystem;
      const native = "café.txt";
      const canonical = native.normalize("NFC");
      yield* world.connect();
      yield* fs.writeFileString(join(world.a.workspace, native), "native authored bytes\n");
      const aliases = yield* fs.exists(join(world.a.workspace, canonical));
      yield* world.a.sync();
      yield* world.b.sync();
      expect(yield* world.b.read(canonical)).toBe("native authored bytes\n");
      yield* world.b.edit(canonical, "remote updated bytes\n");
      yield* world.b.sync();
      const result = yield* Effect.result(world.a.sync());
      if (aliases) {
        expect(result).toMatchObject({ success: { status: "pulled" } });
        expect(yield* world.a.read(native)).toBe("remote updated bytes\n");
      } else {
        expect(result).toMatchObject({
          failure: { _tag: "AuthorNonNfcPathUnsupported" },
        });
        expect(yield* world.a.read(native)).toBe("native authored bytes\n");
        expect(yield* fs.exists(join(world.a.workspace, canonical))).toBe(false);
      }
      expect(
        (yield* fs.readDirectory(world.a.workspace)).filter(
          (name) => name.normalize("NFC") === canonical,
        ),
      ).toEqual([native]);
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect.each(["distinct", "hardlink"] as const)(
  "an ignored NFC twin cannot be blessed by an included NFD key (%s)",
  (kind, context) =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      const fs = yield* FileSystem.FileSystem;
      const native = "café.txt";
      const canonical = native.normalize("NFC");
      yield* fs.writeFileString(join(world.b.workspace, native), "included native bytes\n");
      const distinct = yield* fs
        .writeFileString(join(world.b.workspace, canonical), "PRIVATE_NORMALIZATION_TWIN", {
          flag: "wx",
        })
        .pipe(
          Effect.as(true),
          Effect.catch((error) =>
            error.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(error),
          ),
        );
      if (!distinct) {
        context.skip(true, "filesystem aliases NFC/NFD entries; real twin proof requires Linux VM");
        return;
      }
      if (kind === "hardlink") {
        yield* fs.remove(join(world.b.workspace, canonical));
        yield* fs.link(join(world.b.workspace, native), join(world.b.workspace, canonical));
      }
      const privateValue =
        kind === "hardlink" ? "included native bytes\n" : "PRIVATE_NORMALIZATION_TWIN";
      yield* Effect.sync(() => execFileSync("git", ["init", "--quiet", world.b.workspace]));
      yield* Effect.sync(() =>
        execFileSync("git", ["-C", world.b.workspace, "config", "core.precomposeunicode", "false"]),
      );
      yield* fs.writeFileString(join(world.b.workspace, ".git/info/exclude"), `${canonical}\n`);
      yield* world.a.edit(canonical, "included native bytes\n");
      yield* world.connect();
      yield* world.a.edit(canonical, "remote replacement\n");
      yield* world.a.sync();
      expect(yield* Effect.result(world.b.sync())).toMatchObject({
        failure: { _tag: "AuthorNormalizationTwin" },
      });
      expect(yield* world.b.read(canonical)).toBe(privateValue);
      expect(yield* world.b.read(native)).toBe("included native bytes\n");
      const replacement = join(world.b.home, "editor-replacement");
      yield* fs.writeFileString(replacement, "new native authored bytes\n");
      yield* fs.rename(replacement, join(world.b.workspace, native));
      expect((yield* world.b.sync()).status).toBe("merged");
      expect(yield* world.b.read(canonical)).toBe(privateValue);
      yield* world.a.sync();
      expect(yield* world.a.read(canonical)).toBe("new native authored bytes\n");
      if (kind === "distinct") expect(yield* remoteHolds(world, privateValue)).toBe(false);
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("a new incoming NFC name cannot create a twin beside an ignored NFD entry", (context) =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    const native = "café.txt";
    const canonical = native.normalize("NFC");
    yield* fs.writeFileString(join(world.b.workspace, native), "private native bytes\n");
    const distinct = yield* fs
      .writeFileString(join(world.b.workspace, canonical), "probe", {
        flag: "wx",
      })
      .pipe(
        Effect.as(true),
        Effect.catch((error) =>
          error.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(error),
        ),
      );
    if (!distinct) {
      context.skip(true, "filesystem aliases NFC/NFD entries; real twin proof requires Linux VM");
      return;
    }
    yield* fs.remove(join(world.b.workspace, canonical));
    yield* Effect.sync(() => execFileSync("git", ["init", "--quiet", world.b.workspace]));
    yield* Effect.sync(() =>
      execFileSync("git", ["-C", world.b.workspace, "config", "core.precomposeunicode", "false"]),
    );
    yield* fs.writeFileString(join(world.b.workspace, ".git/info/exclude"), `${native}\n`);
    yield* world.connect();
    yield* world.a.edit(canonical, "remote new file\n");
    yield* world.a.sync();
    expect(yield* Effect.result(world.b.sync())).toMatchObject({
      failure: { _tag: "AuthorNormalizationTwin" },
    });
    expect(yield* world.b.read(native)).toBe("private native bytes\n");
    expect(yield* fs.exists(join(world.b.workspace, canonical))).toBe(false);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect.each(["directory-symlink", "file", "dangling-symlink"] as const)(
  "incoming paths cannot traverse an ignored local parent that is a %s",
  (kind) =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      const fs = yield* FileSystem.FileSystem;
      yield* world.connect();
      yield* Effect.sync(() => execFileSync("git", ["init", "--quiet", world.b.workspace]));
      yield* fs.writeFileString(join(world.b.workspace, ".git/info/exclude"), "private\n");
      const outside = yield* fs.makeTempDirectoryScoped({
        prefix: "skit-outside-author-",
      });
      yield* fs.writeFileString(join(outside, "keep.txt"), "leave outside content alone\n");
      const parent = join(world.b.workspace, "private");
      const target = kind === "dangling-symlink" ? join(outside, "missing") : outside;
      if (kind === "file") yield* fs.writeFileString(parent, "private local file\n");
      else yield* fs.symlink(target, parent);
      yield* world.a.edit("private/new.md", "remote addition\n");
      yield* world.a.sync();
      yield* world.b.edit(
        "skills/review/SKILL.md",
        `${yield* world.b.read("skills/review/SKILL.md")}\nLocal edit.\n`,
      );
      const current = yield* world.server.current();
      const result = yield* Effect.result(world.b.sync());
      expect(yield* fs.exists(join(outside, "new.md"))).toBe(false);
      expect(yield* fs.readFileString(join(outside, "keep.txt"))).toBe(
        "leave outside content alone\n",
      );
      if (kind === "file") expect(yield* fs.readFileString(parent)).toBe("private local file\n");
      else expect(yield* fs.readLink(parent)).toBe(target);
      expect(result).toMatchObject({
        failure: { _tag: "AuthorLocalPathNotObserved", path: "private" },
      });
      expect(yield* world.server.current()).toBe(current);
      yield* world.b.restart();
      expect(yield* Effect.result(world.b.sync())).toMatchObject({
        failure: { _tag: "AuthorLocalPathNotObserved", path: "private" },
      });
      expect(yield* fs.exists(join(outside, "new.md"))).toBe(false);
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect.each(["repository", "plain"] as const)(
  "ignored credentials never enter local history, SKIT revisions or merge inputs (%s)",
  (format) =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      const fs = yield* FileSystem.FileSystem;
      const sentinel = "SKIT_TEST_IGNORED_CREDENTIAL_SENTINEL";
      for (const device of [world.a, world.b]) {
        if (format === "repository")
          yield* Effect.sync(() => execFileSync("git", ["init", "--quiet", device.workspace]));
        yield* fs.writeFileString(join(device.workspace, ".gitignore"), ".env\n");
        yield* fs.writeFileString(join(device.workspace, ".env"), `${sentinel}:${device.name}`);
        yield* fs.writeFileString(join(device.workspace, ".DS_Store"), sentinel);
      }
      yield* world.connect(); // Includes the initial SKIT create, not only updates.
      yield* world.a.edit("notes/a.txt", "remote authored change\n");
      yield* world.a.sync();
      yield* world.b.edit("notes/b.txt", "local authored change\n");
      const eventStart = (yield* world.server.events()).length;
      expect((yield* world.b.sync()).status).toBe("merged");
      // B posted its own input and the merge.
      expect(
        (yield* world.server.events())
          .slice(eventStart)
          .filter((event) => event === "b:after-post"),
      ).toHaveLength(2);
      for (const device of [world.a, world.b]) {
        for (const stored of yield* loadStoredTrees(device.home)) {
          expect(
            stored.tree.some((entry) =>
              [".env", ".DS_Store", "skit.remote.json"].includes(entry.path),
            ),
          ).toBe(false);
          for (const entry of stored.tree)
            if (entry.kind === "file")
              expect(Buffer.from(entry.bytes).includes(Buffer.from(sentinel))).toBe(false);
        }
        expect(yield* device.read(".env")).toBe(`${sentinel}:${device.name}`);
        if (format === "plain")
          expect(yield* fs.exists(join(device.workspace, ".git"))).toBe(false);
      }
      for (const { tree } of yield* world.server.revisions())
        expect(
          tree.some((entry) => [".env", ".DS_Store", "skit.remote.json"].includes(entry.path)),
        ).toBe(false);
      expect(yield* remoteHolds(world, sentinel)).toBe(false);
    }).pipe(Effect.provide(testPlatformLayer)),
);

const expectRecoverable = Effect.fn("Test.expectAuthorVersionsRecoverable")(function* (
  world: World,
) {
  const missing = yield* world.missing(yield* world.copies());
  expect(missing, (yield* world.server.events()).join("\n")).toEqual([]);
});

const expectConverged = Effect.fn("Test.expectAuthorDevicesConverged")(function* (world: World) {
  expect(yield* world.a.files()).toEqual(yield* world.b.files());
});

it.effect("merges independent offline edits and keeps the exact bytes of both versions", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    yield* world.connect();
    yield* world.server.setOnline("a", false);
    yield* world.server.setOnline("b", false);
    yield* world.a.edit("notes/a.txt", "A's offline edit\n", "remote");
    yield* world.b.edit("notes/b.txt", "B's offline edit\n", "remote");
    expect(Result.isFailure(yield* Effect.result(world.a.sync()))).toBe(true);
    expect(Result.isFailure(yield* Effect.result(world.b.sync()))).toBe(true);
    yield* world.server.setOnline("a", true);
    yield* world.server.setOnline("b", true);
    yield* world.a.sync();
    yield* world.b.sync();
    yield* world.a.sync();
    yield* expectRecoverable(world);
    yield* expectConverged(world);
    const revisions = (yield* world.server.revisions()).length;
    expect((yield* world.a.sync()).status).toBe("up_to_date");
    expect((yield* world.b.sync()).status).toBe("up_to_date");
    expect((yield* world.server.revisions()).length).toBe(revisions);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("every stored revision names its credential, device and first-observed time", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    yield* world.connect();
    yield* world.a.edit("notes/a.txt", "A's edit\n", "remote");
    yield* world.b.edit("notes/b.txt", "B's edit\n", "remote");
    // Observe each edit now; sync must report this first observation, not its own later one.
    const observed = (device: World["a"]) =>
      refreshAuthorHistory(device.workspace, device.home).pipe(
        Effect.andThen(loadAuthorHistory(device.workspace, device.home)),
        Effect.map((events) => events.at(-1)!),
      );
    const a = yield* observed(world.a);
    yield* TestClock.adjust("1 minute");
    const b = yield* observed(world.b);
    yield* TestClock.adjust("1 minute");
    yield* world.a.sync();
    yield* world.b.sync();
    expect(a.revision.author.device).not.toBe(b.revision.author.device);
    const [aInput, bInput, merge] = (yield* world.server.revisions()).slice(-3);
    expect(aInput).toMatchObject({ device: "a", revision: { author: a.revision.author } });
    expect(bInput).toMatchObject({ device: "b", revision: { author: b.revision.author } });
    // B's merge names A's revision, which was current, and B's own input as its parents.
    expect(merge).toMatchObject({
      device: "b",
      revision: {
        parents: [aInput?.id, bInput?.id],
        author: { device: b.revision.author.device },
      },
    });
    expect(yield* world.server.current()).toBe(merge?.id);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect.each([
  { first: "b", second: "a" },
  { first: "a", second: "b" },
] as const)(
  "the later edit of the same line wins whichever device syncs last ($second edits later)",
  ({ first, second }) =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      const path = "skills/review/SKILL.md";
      const skill = (line: string) =>
        `---\nname: review\ndescription: Review code.\n---\n# Review\n${line}\n`;
      yield* world.connect();
      yield* world.a.edit(path, skill("Keep comments brief."), "remote");
      yield* world.a.sync();
      yield* world.b.sync();
      // Each edit is observed at its own time; sync order is A, B, A regardless.
      yield* world[first].edit(path, skill(`${first} edited first`), "remote");
      yield* refreshAuthorHistory(world[first].workspace, world[first].home);
      yield* TestClock.adjust("1 minute");
      yield* world[second].edit(path, skill(`${second} edited later`), "remote");
      yield* refreshAuthorHistory(world[second].workspace, world[second].home);
      yield* world.a.sync();
      expect(yield* world.b.sync()).toMatchObject({
        status: "merged",
        choices: [{ path, kind: "both_modified", kept: second === "b" ? "local" : "remote" }],
      });
      yield* world.a.sync();
      expect(yield* world.a.read(path)).toBe(skill(`${second} edited later`));
      expect(yield* world.b.read(path)).toBe(skill(`${second} edited later`));
      // The earlier edit is never lost: it stays on the server as a revision of its own.
      expect((yield* world.server.revisions()).map(({ tree }) => textAt(tree, path))).toContain(
        skill(`${first} edited first`),
      );
      yield* expectRecoverable(world);
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("a skill renamed on one device keeps the other device's concurrent edit", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    const skill = (name: string, extra = "") =>
      `---\nname: ${name}\ndescription: SKIT release notes.\n---\n# Notes\nKeep them short.\n${extra}`;
    yield* world.connect();
    yield* world.a.edit("extra/release-notes/SKILL.md", skill("release-notes"), "remote");
    yield* world.a.edit("extra/release-notes/TEMPLATE.md", "## Changes\n", "remote");
    yield* world.a.sync();
    yield* world.b.sync();
    // A renames the folder and the name; B, not yet synced, edits the skill at its old path.
    yield* fs.rename(
      join(world.a.workspace, "extra/release-notes"),
      join(world.a.workspace, "extra/changelog"),
    );
    yield* world.a.edit("extra/changelog/SKILL.md", skill("changelog"), "remote");
    yield* world.b.edit(
      "extra/release-notes/SKILL.md",
      skill("release-notes", "Link every pull request.\n"),
      "remote",
    );
    yield* world.a.sync();
    yield* world.b.sync();
    yield* world.a.sync();
    for (const device of [world.a, world.b]) {
      expect(yield* device.read("extra/changelog/SKILL.md")).toBe(
        skill("changelog", "Link every pull request.\n"),
      );
      expect(yield* device.read("extra/changelog/TEMPLATE.md")).toBe("## Changes\n");
      // No stub skill is left behind, and sync removes the folder its deletions emptied.
      expect(yield* fs.exists(join(device.workspace, "extra/release-notes"))).toBe(false);
    }
    yield* expectConverged(world);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("a folder emptied by sync is removed, but one holding an ignored file stays", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.sync(() => execFileSync("git", ["init", "--quiet", world.b.workspace]));
    yield* fs.writeFileString(join(world.b.workspace, ".git/info/exclude"), "notes.local\n");
    yield* world.connect();
    yield* world.a.edit(
      "extra/gone/SKILL.md",
      "---\nname: gone\ndescription: Gone.\n---\n",
      "remote",
    );
    yield* world.a.edit(
      "extra/kept/SKILL.md",
      "---\nname: kept\ndescription: Kept.\n---\n",
      "remote",
    );
    yield* world.a.sync();
    yield* world.b.sync();
    // B keeps a private, ignored note inside one of the folders A is about to delete.
    yield* fs.writeFileString(join(world.b.workspace, "extra/kept/notes.local"), "private\n");
    yield* fs.remove(join(world.a.workspace, "extra"), { recursive: true });
    yield* world.a.sync();
    yield* world.b.sync();
    expect(yield* fs.exists(join(world.b.workspace, "extra/gone"))).toBe(false);
    expect(yield* fs.exists(join(world.b.workspace, "extra/kept/SKILL.md"))).toBe(false);
    expect(yield* fs.readFileString(join(world.b.workspace, "extra/kept/notes.local"))).toBe(
      "private\n",
    );
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("independent insertions in the same skill merge through real device sync", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    yield* world.connect();
    const path = "skills/review/SKILL.md";
    const base =
      "---\nname: review\ndescription: Review code.\n---\n# Review\n\nFirst section.\n\nLast section.\n";
    yield* world.a.edit(path, base, "local-history");
    yield* world.a.sync();
    yield* world.b.sync();
    yield* world.a.edit(
      path,
      base.replace("First section.", "Local introduction.\nFirst section."),
      "local-history",
    );
    yield* world.b.edit(
      path,
      base.replace("Last section.", "Last section.\nRemote conclusion."),
      "local-history",
    );
    yield* world.a.sync();
    const beforeMerge = (yield* world.server.revisions()).length;
    // A clean merge decides nothing.
    expect(yield* world.b.sync()).toMatchObject({ status: "merged", choices: [] });
    const afterMerge = yield* world.server.revisions();
    expect(afterMerge).toHaveLength(beforeMerge + 2);
    // B's own input is posted before the merge built from it.
    expect(textAt(afterMerge.at(-2)!.tree, path)).toBe(
      base.replace("Last section.", "Last section.\nRemote conclusion."),
    );
    yield* world.a.sync();
    expect(yield* world.a.read(path)).toBe(
      base
        .replace("First section.", "Local introduction.\nFirst section.")
        .replace("Last section.", "Last section.\nRemote conclusion."),
    );
    yield* expectConverged(world);
    yield* expectRecoverable(world);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("a lost move response cannot override the revision's later descendant", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    yield* world.connect();
    yield* world.a.edit("notes/a.txt", "accepted x", "remote");
    // The move lands, but A never hears so: A is left sending.
    yield* world.server.dropNextResponse("a");
    expect(Result.isFailure(yield* Effect.result(world.a.sync()))).toBe(true);
    yield* world.b.sync();
    yield* world.b.edit("notes/a.txt", "descendant y", "remote");
    yield* world.b.sync();
    const bindingPath = join(world.a.home, "sync-bindings.json");
    const before = yield* fs.readFileString(bindingPath);
    const preview = yield* world.a.preview();
    expect(yield* fs.readFileString(bindingPath)).toBe(before);
    const result = yield* world.a.sync();
    expect(yield* world.a.read("notes/a.txt")).toBe("descendant y");
    expect([preview, result]).toMatchObject([
      { status: "ready", action: "pull" },
      { status: "pulled", paths: ["notes/a.txt"] },
    ]);
    yield* expectConverged(world);
    yield* expectRecoverable(world);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("a sending device merges newer local edits over a later remote revision", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    yield* world.connect();
    yield* world.a.edit("notes/a.txt", "accepted x", "remote");
    yield* world.server.dropNextResponse("a");
    expect(Result.isFailure(yield* Effect.result(world.a.sync()))).toBe(true);
    yield* world.a.edit("notes/a.txt", "new local x-prime", "local-history");
    yield* world.b.sync();
    yield* world.b.edit("notes/b.txt", "new remote addition", "remote");
    yield* world.b.sync();
    expect((yield* world.a.sync()).status).toBe("merged");
    expect(yield* world.a.read("notes/a.txt")).toBe("new local x-prime");
    expect(yield* world.a.read("notes/b.txt")).toBe("new remote addition");
    yield* world.b.sync();
    yield* expectConverged(world);
    yield* expectRecoverable(world);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("a device that loses the move to another device merges in the same sync", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    yield* world.connect();
    yield* world.a.edit("notes/a.txt", "A's version\n", "remote");
    yield* world.b.edit("notes/b.txt", "B's version\n", "remote");
    const gate = yield* world.server.gate("a", "before-move");
    const pending = yield* world.a.startSync();
    yield* gate.reached();
    expect((yield* world.b.sync()).status).toBe("pushed");
    const theirs = yield* world.server.current();
    yield* gate.release();
    expect(yield* Fiber.join(pending)).toMatchObject({ status: "merged" });
    const merge = (yield* world.server.revisions()).at(-1)!;
    expect(merge.revision.parents[0]).toBe(theirs);
    expect(yield* world.server.current()).toBe(merge.id);
    expect(yield* world.a.read("notes/b.txt")).toBe("B's version\n");
    expect((yield* world.b.sync()).status).toBe("pulled");
    yield* expectRecoverable(world);
    yield* expectConverged(world);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("a state flush failure stops sync before it moves current", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    yield* world.connect();
    yield* world.a.edit("notes/a.txt", "not yet sent", "local-history");
    const current = yield* world.server.current();
    const bindingPath = join(world.a.home, "sync-bindings.json");
    const before = yield* fs.readFileString(bindingPath);
    const failed = yield* Effect.result(
      world.a.sync().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          open: Effect.fn("Test.failStateFlush")(function* (path, options) {
            const file = yield* fs.open(path, options);
            return path.includes("/.sync-state-")
              ? {
                  ...file,
                  writeAll: (bytes: Uint8Array) => file.writeAll(bytes),
                  sync: fs.readFile(join(world.a.home, "missing-flush-target")).pipe(Effect.asVoid),
                }
              : file;
          }),
        }),
      ),
    );
    expect(Result.isFailure(failed)).toBe(true);
    expect(yield* world.server.current()).toBe(current);
    expect(yield* fs.readFileString(bindingPath)).toBe(before);
    expect((yield* world.a.sync()).status).toBe("pushed");
    yield* world.b.sync();
    yield* expectConverged(world);
    yield* expectRecoverable(world);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("invalid authored content syncs alongside independent changes on another device", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    yield* world.connect();
    yield* world.a.edit("skills/review/SKILL.md", "---\nname: [unfinished\n", "remote");
    yield* world.b.edit("notes/independent.txt", "valid independent change", "remote");
    expect((yield* world.a.sync()).status).toBe("pushed");
    expect((yield* world.b.sync()).status).toBe("merged");
    expect((yield* world.a.sync()).status).toBe("pulled");
    expect(yield* world.a.read("skills/review/SKILL.md")).toBe("---\nname: [unfinished\n");
    expect(yield* world.a.read("notes/independent.txt")).toBe("valid independent change");
    yield* expectConverged(world);
    yield* expectRecoverable(world);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("an interrupted pull sends nothing and the next sync pulls again", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    yield* world.connect();
    yield* world.a.edit("notes/deleted.txt", "remove remotely");
    yield* world.a.sync();
    yield* world.b.sync();
    yield* fs.remove(join(world.b.workspace, "notes/deleted.txt"));
    yield* world.b.edit("notes/new.txt", "remote addition");
    yield* world.b.sync();
    const revisions = (yield* world.server.revisions()).length;
    const beforePull = (yield* world.server.events()).length;
    const reachedApply = yield* Deferred.make<void>();
    const interrupted = yield* world.a.startSync().pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        rename: Effect.fn("Test.pauseRemoteOnlyApplication")(function* (from, to) {
          if (to.endsWith("/notes/new.txt")) {
            yield* Deferred.succeed(reachedApply, undefined);
            yield* Effect.never;
          }
          yield* fs.rename(from, to);
        }),
      }),
    );
    yield* Deferred.await(reachedApply);
    yield* world.a.restart();
    expect(Exit.hasInterrupts(yield* Fiber.await(interrupted))).toBe(true);
    // Only reads: nothing was posted or moved.
    const reads = (events: ReadonlyArray<string>) =>
      events.every((event) => event === "a:before-current");
    expect(reads((yield* world.server.events()).slice(beforePull))).toBe(true);
    const beforeRetry = (yield* world.server.events()).length;
    expect((yield* world.a.sync()).status).toBe("pulled");
    expect(yield* world.a.read("notes/new.txt")).toBe("remote addition");
    expect(yield* fs.exists(join(world.a.workspace, "notes/deleted.txt"))).toBe(false);
    expect(reads((yield* world.server.events()).slice(beforeRetry))).toBe(true);
    yield* expectConverged(world);
    expect((yield* world.a.sync()).status).toBe("up_to_date");
    expect((yield* world.b.sync()).status).toBe("up_to_date");
    expect((yield* world.server.revisions()).length).toBe(revisions);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("recovers a move whose response disappeared without posting it again as new", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    yield* world.connect();
    yield* world.a.edit("notes/a.txt", "accepted before disconnect\n", "remote");
    yield* world.server.dropNextResponse("a");
    expect(Result.isFailure(yield* Effect.result(world.a.sync()))).toBe(true);
    const committed = yield* world.server.revisions();
    expect(yield* world.server.current()).toBe(committed.at(-1)?.id);
    yield* expectRecoverable(world);
    // The binding still says Sending; a preview reports the landed move and changes nothing.
    const bindingPath = join(world.a.home, "sync-bindings.json");
    const before = yield* fs.readFileString(bindingPath);
    expect(JSON.parse(before).skits["skit://registry.example/swyx/tools"]._tag).toBe("Sending");
    expect((yield* world.a.preview()).status).toBe("up_to_date");
    expect(yield* fs.readFileString(bindingPath)).toBe(before);
    expect((yield* world.a.sync()).status).toBe("up_to_date");
    expect(JSON.parse(yield* fs.readFileString(bindingPath)).skits).toEqual({
      "skit://registry.example/swyx/tools": { _tag: "Idle", base: committed.at(-1)?.id },
    });
    expect(yield* world.server.revisions()).toEqual(committed);
    yield* world.b.sync();
    yield* world.b.edit("notes/a.txt", "B's later edit to the same file\n", "remote");
    yield* world.b.sync();
    expect((yield* world.a.sync()).status).toBe("pulled");
    yield* expectRecoverable(world);
    yield* expectConverged(world);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("a lost post response is posted again, which records nothing new", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    yield* world.connect();
    yield* world.a.edit("notes/a.txt", "posted before disconnect\n", "remote");
    yield* world.server.dropNextResponse("a", "after-post");
    expect(Result.isFailure(yield* Effect.result(world.a.sync()))).toBe(true);
    const posted = yield* world.server.revisions();
    expect((yield* world.a.sync()).status).toBe("pushed");
    expect(yield* world.server.revisions()).toEqual(posted);
    expect(yield* world.server.current()).toBe(posted.at(-1)?.id);
    yield* world.b.sync();
    yield* expectRecoverable(world);
    yield* expectConverged(world);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "closing one device runtime after its move leaves the remote and other device running",
  () =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      yield* world.connect();
      yield* world.a.edit("notes/a.txt", "committed before interruption\n", "remote");
      const gate = yield* world.server.gate("a", "after-move");
      const pending = yield* world.a.startSync();
      yield* gate.reached();
      yield* world.a.restart();
      const stopped = yield* Effect.exit(Fiber.join(pending));
      expect(Exit.isFailure(stopped)).toBe(true);
      if (Exit.isFailure(stopped)) expect(Cause.hasInterrupts(stopped.cause)).toBe(true);
      expect((yield* world.b.sync()).status).toBe("pulled");
      expect((yield* world.a.sync()).status).toBe("up_to_date");
      yield* expectRecoverable(world);
      yield* expectConverged(world);
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "the oracle detects missing and corrupted remote bytes without trusting manifest hashes",
  () =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      yield* world.connect();
      yield* world.a.edit("notes/a.txt", "unique evidence\n", "remote");
      yield* world.a.sync();
      const copies = yield* world.copies();
      expect(yield* world.missing(copies)).toEqual([]);
      const corrupted = copies.map((copy) => ({
        ...copy,
        files: copy.files.map((file) =>
          copy.kind === "remote" && file.path === "notes/a.txt"
            ? { ...file, bytes: Buffer.from("corrupted") }
            : file,
        ),
      }));
      expect((yield* world.missing(corrupted)).map((edit) => edit.path)).toEqual(["notes/a.txt"]);
      expect(yield* world.missing(copies.filter((copy) => copy.kind !== "remote"))).toHaveLength(1);
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("an injection that never reaches its boundary fails the scenario", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* makeAuthorSyncServer();
          yield* server.gate("a", "after-move");
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(Cause.squash(exit.cause)).toMatchObject({
        message: 'Unreached author-sync faults: [{"device":"a","boundary":"after-move"}]',
      });
  }),
);

it.effect("same-file overlaps edited at once keep the later syncing input and converge", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    yield* world.connect();
    yield* world.a.edit("notes/shared.txt", "A's alternative\n");
    yield* world.b.edit("notes/shared.txt", "B's alternative\n");
    yield* world.a.sync();
    expect(yield* world.b.sync()).toMatchObject({
      status: "merged",
      choices: [{ path: "notes/shared.txt", kept: "local" }],
    });
    yield* world.a.sync();
    yield* expectRecoverable(world);
    yield* expectConverged(world);
    expect(yield* world.b.read("notes/shared.txt")).toBe("B's alternative\n");
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("edit beats local deletion, and the deleting tree stays on the server", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    yield* world.connect();
    yield* world.a.edit("notes/shared.txt", "base");
    yield* world.a.sync();
    yield* world.b.sync();
    yield* fs.remove(join(world.b.workspace, "notes/shared.txt"));
    yield* world.a.edit("notes/shared.txt", "remote edit", "remote");
    yield* world.a.sync();
    const before = (yield* world.server.revisions()).length;
    expect(yield* world.b.sync()).toMatchObject({
      status: "merged",
      choices: [{ path: "notes/shared.txt", kind: "delete_modify", kept: "remote" }],
    });
    expect(yield* world.b.read("notes/shared.txt")).toBe("remote edit");
    const revisions = yield* world.server.revisions();
    expect(revisions).toHaveLength(before + 2);
    const [deleting, merge] = revisions.slice(-2);
    expect(deleting && textAt(deleting.tree, "notes/shared.txt")).toBeUndefined();
    expect(merge && textAt(merge.tree, "notes/shared.txt")).toBe("remote edit");
    // The merge kept A's files exactly, so A has nothing to pull.
    expect((yield* world.a.sync()).status).toBe("up_to_date");
    expect((yield* world.server.revisions()).length).toBe(before + 2);
    yield* expectConverged(world);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("a local save while posting the merge input prevents stale application", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    yield* world.connect();
    yield* world.a.edit("notes/a.txt", "remote A", "remote");
    yield* world.a.sync();
    yield* world.b.edit("notes/b.txt", "local B", "remote");
    const current = yield* world.server.current();
    const gate = yield* world.server.gate("b", "after-post");
    const pending = yield* world.b.startSync();
    yield* gate.reached();
    yield* world.b.edit("notes/b.txt", "new local B", "local-history");
    yield* gate.release();
    expect(yield* Effect.flip(Fiber.join(pending))).toMatchObject({
      _tag: "LocalFilesChangedDuringSync",
    });
    expect(yield* world.b.read("notes/b.txt")).toBe("new local B");
    expect(yield* world.server.current()).toBe(current);
    expect((yield* world.b.sync()).status).toBe("merged");
    yield* world.a.sync();
    expect(yield* world.a.read("notes/b.txt")).toBe("new local B");
    yield* expectConverged(world);
    yield* expectRecoverable(world);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("a late device with different files merges with no base and keeps both sides", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    yield* world.connect();
    yield* world.a.edit("notes/a.txt", "already on the remote\n", "remote");
    yield* world.a.sync();
    yield* world.c.edit("notes/c.txt", "new device's files\n", "remote");
    expect((yield* world.c.sync()).status).toBe("merged");
    expect(yield* world.c.read("notes/c.txt")).toBe("new device's files\n");
    expect(yield* world.c.read("notes/a.txt")).toBe("already on the remote\n");
    expect((yield* world.a.sync()).status).toBe("pulled");
    expect(yield* world.a.files()).toEqual(yield* world.c.files());
    yield* expectRecoverable(world);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("a late device with no files pulls the SKIT", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    yield* world.connect();
    yield* world.a.edit("notes/a.txt", "already on the remote\n", "remote");
    yield* world.a.sync();
    for (const file of yield* world.c.files()) yield* fs.remove(join(world.c.workspace, file.path));
    expect((yield* world.c.sync()).status).toBe("pulled");
    expect(yield* world.c.files()).toEqual(yield* world.a.files());
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("an editor save during a push is kept locally and sent by the next sync", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    yield* world.connect();
    yield* world.a.edit("notes/a.txt", "first save\n", "remote");
    const gate = yield* world.server.gate("a", "after-post");
    const pending = yield* world.a.startSync();
    yield* gate.reached();
    yield* world.a.edit("notes/a.txt", "save while upload was in flight\n", "remote");
    yield* gate.release();
    expect((yield* Fiber.join(pending)).status).toBe("pushed");
    expect(yield* world.a.read("notes/a.txt")).toBe("save while upload was in flight\n");
    const bindingPath = join(world.a.home, "sync-bindings.json");
    const beforePreview = yield* fs.readFileString(bindingPath);
    expect(yield* world.a.preview()).toMatchObject({ status: "ready", action: "push" });
    expect(yield* fs.readFileString(bindingPath)).toBe(beforePreview);
    yield* world.b.sync();
    expect(yield* world.b.read("notes/a.txt")).toBe("first save\n");
    expect((yield* world.a.sync()).status).toBe("pushed");
    yield* world.b.sync();
    expect(yield* world.b.read("notes/a.txt")).toBe("save while upload was in flight\n");
    yield* expectRecoverable(world);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("a merge stopped by a newer edit keeps remote changes for the next merge", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    yield* world.connect();
    yield* world.a.edit("notes/deleted.txt", "remove on B");
    yield* world.a.sync();
    yield* world.b.sync();
    const localBase = yield* world.server.current();
    yield* world.b.edit("notes/remote.txt", "remote addition");
    yield* fs.remove(join(world.b.workspace, "notes/deleted.txt"));
    yield* world.b.sync();
    yield* world.a.edit("notes/a.txt", "first local save");
    const gate = yield* world.server.gate("a", "after-post");
    const pending = yield* world.a.startSync();
    yield* gate.reached();
    yield* world.a.edit("notes/a.txt", "newer local save");
    yield* gate.release();
    expect(yield* Effect.flip(Fiber.join(pending))).toMatchObject({
      _tag: "LocalFilesChangedDuringSync",
    });
    expect(yield* fs.exists(join(world.a.workspace, "notes/remote.txt"))).toBe(false);
    expect(yield* fs.exists(join(world.a.workspace, "notes/deleted.txt"))).toBe(true);
    // A newer remote revision must merge with the newer local edit too.
    yield* world.b.edit("notes/remote.txt", "newer remote addition");
    yield* world.b.sync();
    expect((yield* world.a.sync()).status).toBe("merged");
    // A's newer edit was posted as an edit of the base A last synced, before any merge.
    const input = (yield* world.server.revisions()).find(
      ({ tree }) =>
        textAt(tree, "notes/a.txt") === "newer local save" &&
        textAt(tree, "notes/remote.txt") === undefined,
    );
    expect(input?.revision.parents).toEqual([localBase]);
    expect(yield* world.a.read("notes/a.txt")).toBe("newer local save");
    expect(yield* world.a.read("notes/remote.txt")).toBe("newer remote addition");
    expect(yield* fs.exists(join(world.a.workspace, "notes/deleted.txt"))).toBe(false);
    yield* world.b.sync();
    yield* expectConverged(world);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect.each(["pull", "merge"] as const)(
  "restart after only some files of a %s were written takes the newer remote edit",
  (operation) =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      const fs = yield* FileSystem.FileSystem;
      yield* world.connect();
      yield* world.b.edit("notes/1.txt", "first remote file");
      yield* world.b.edit("notes/2.txt", "second remote file");
      yield* world.b.sync();
      if (operation === "merge") yield* world.a.edit("notes/a.txt", "independent local edit");
      const appliedFirst = yield* Deferred.make<void>();
      const pending = yield* world.a.startSync().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: Effect.fn("Test.interruptPartialApplication")(function* (from, to) {
            yield* fs.rename(from, to);
            if (to.endsWith("/notes/1.txt")) {
              yield* Deferred.succeed(appliedFirst, undefined);
              yield* Effect.never;
            }
          }),
        }),
      );
      yield* Deferred.await(appliedFirst);
      expect(yield* world.a.read("notes/1.txt")).toBe("first remote file");
      expect(yield* fs.exists(join(world.a.workspace, "notes/2.txt"))).toBe(false);
      yield* world.a.restart();
      expect(Exit.hasInterrupts(yield* Fiber.await(pending))).toBe(true);
      const bindingPath = join(world.a.home, "sync-bindings.json");
      const beforePreview = yield* fs.readFileString(bindingPath);
      expect(JSON.parse(beforePreview).skits["skit://registry.example/swyx/tools"]).toMatchObject({
        _tag: "Writing",
        next: { _tag: operation === "pull" ? "Idle" : "Sending" },
      });
      expect((yield* world.a.preview()).status).toBe("ready");
      expect(yield* fs.readFileString(bindingPath)).toBe(beforePreview);
      expect(yield* fs.exists(join(world.a.workspace, "notes/2.txt"))).toBe(false);
      // The other device can advance a file already written on A before A resumes.
      yield* TestClock.adjust("1 minute");
      yield* world.b.edit("notes/1.txt", "newer remote version");
      yield* world.b.sync();
      expect((yield* world.a.sync()).status).toBe(operation === "pull" ? "pulled" : "merged");
      expect(yield* world.a.read("notes/1.txt")).toBe("newer remote version");
      if (operation === "merge")
        expect(yield* world.a.read("notes/a.txt")).toBe("independent local edit");
      yield* world.b.sync();
      yield* expectConverged(world);
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("repeatedly interrupted pulls keep real edits and finish remote deletions", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    yield* world.connect();
    yield* world.a.edit("notes/deleted.txt", "delete remotely");
    yield* world.a.edit("notes/edited.txt", "remote: original\nlocal: original\n");
    yield* world.a.sync();
    yield* world.b.sync();
    const base = yield* world.server.current();
    yield* world.b.edit("notes/1.txt", "first downloaded file");
    yield* world.b.edit("notes/2.txt", "second downloaded file");
    yield* world.b.edit("notes/edited.txt", "remote: downloaded edit\nlocal: original\n");
    yield* fs.remove(join(world.b.workspace, "notes/deleted.txt"));
    yield* world.b.sync();

    for (const path of ["notes/1.txt", "notes/2.txt"]) {
      const written = yield* Deferred.make<void>();
      const pending = yield* world.a.startSync().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: Effect.fn("Test.interruptRepeatedPull")(function* (from, to) {
            yield* fs.rename(from, to);
            if (to === join(world.a.workspace, path)) {
              yield* Deferred.succeed(written, undefined);
              yield* Effect.never;
            }
          }),
        }),
      );
      yield* Deferred.await(written);
      yield* world.a.restart();
      expect(Exit.hasInterrupts(yield* Fiber.await(pending))).toBe(true);
      if (path === "notes/1.txt") {
        yield* world.a.edit(
          "notes/edited.txt",
          "remote: original\nlocal: real local edit\n",
          "remote",
        );
        yield* fs.remove(join(world.a.workspace, "skills/review/SKILL.md"));
      }
    }

    expect((yield* world.a.sync()).status).toBe("merged");
    expect(yield* world.a.read("notes/edited.txt")).toBe(
      "remote: downloaded edit\nlocal: real local edit\n",
    );
    expect(yield* fs.exists(join(world.a.workspace, "notes/deleted.txt"))).toBe(false);
    expect(yield* fs.exists(join(world.a.workspace, "skills/review/SKILL.md"))).toBe(false);
    // The real edit is also recorded on its original base without any downloaded additions.
    const input = (yield* world.server.revisions()).find(
      ({ tree }) =>
        textAt(tree, "notes/edited.txt") === "remote: original\nlocal: real local edit\n" &&
        textAt(tree, "notes/1.txt") === undefined &&
        textAt(tree, "notes/2.txt") === undefined,
    );
    expect(input?.revision.parents).toEqual([base]);
    yield* world.b.sync();
    yield* expectConverged(world);
    yield* expectRecoverable(world);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("a history failure after a pull cannot leave a stale base", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    yield* world.connect();
    yield* world.b.edit("notes/remote.txt", "first remote version");
    yield* world.b.sync();
    const failed = yield* Effect.result(
      world.a.sync().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readDirectory: Effect.fn("Test.failHistoryAfterApplication")(function* (path) {
            if (
              path === (yield* fs.realPath(world.a.workspace)) &&
              (yield* fs.exists(join(world.a.workspace, "notes/remote.txt")))
            )
              return yield* fs.readDirectory(join(world.a.home, "missing-history-directory"));
            return yield* fs.readDirectory(path);
          }),
        }),
      ),
    );
    expect(Result.isFailure(failed)).toBe(true);
    expect(yield* world.a.read("notes/remote.txt")).toBe("first remote version");
    yield* world.b.edit("notes/remote.txt", "second remote version");
    yield* world.b.sync();
    expect((yield* world.a.sync()).status).toBe("pulled");
    expect(yield* world.a.read("notes/remote.txt")).toBe("second remote version");
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "multiple observed offline saves remain readable from local history after reconnect",
  () =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      yield* world.connect();
      yield* world.server.setOnline("a", false);
      yield* world.a.edit("notes/a.txt", "earlier offline save\n", "local-history");
      expect(Result.isFailure(yield* Effect.result(world.a.sync()))).toBe(true);
      yield* world.a.edit("notes/a.txt", "later offline save\n", "local-history");
      expect(Result.isFailure(yield* Effect.result(world.a.sync()))).toBe(true);
      yield* world.server.setOnline("a", true);
      yield* world.a.sync();
      yield* expectRecoverable(world);
    }).pipe(Effect.provide(testPlatformLayer)),
);

const editorOperation = Schema.Struct({
  device: Schema.Literals(["a", "b"]),
  slot: Schema.Literals([0, 1]),
  content: Schema.String,
});
const operation = Arbitrary.schema(
  Schema.Struct({ ...editorOperation.fields, offline: Schema.Boolean }),
);

it.effect.prop(
  "keeps synced versions and converges through generated sequential edits and outages",
  [Arbitrary.array(operation, { minLength: 1, maxLength: 6 })],
  ([operations]) =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      yield* world.connect();
      // Independent oracle for sequential edits: the last editor input at each path is the
      // current content. It never calls the production planner to derive an expected merge.
      const expected = new Map<string, string>();
      for (const [index, input] of operations.entries()) {
        const device = world[input.device];
        const other = input.device === "a" ? world.b : world.a;
        const path = `notes/${input.slot}.txt`;
        const content = `${input.device}:${index}:${input.content}`;
        if (input.offline) yield* world.server.setOnline(input.device, false);
        yield* device.edit(path, content, "remote");
        if (input.offline) expect(Result.isFailure(yield* Effect.result(device.sync()))).toBe(true);
        yield* world.server.setOnline(input.device, true);
        yield* device.sync();
        yield* other.sync();
        // The editor writes UTF-8 bytes. JS lone surrogates become replacement characters
        // at that boundary; compare decoded bytes rather than an unencodable JS string.
        expected.set(path, Buffer.from(content).toString("utf8"));
        yield* expectRecoverable(world);
        yield* expectConverged(world);
        for (const [path, content] of expected) expect(yield* other.read(path)).toBe(content);
      }
    }).pipe(Effect.provide(testPlatformLayer)),
  // Twenty runs of up to six syncs each; every changed save writes a durable tree and revision.
  { timeout: 60_000, arbitrary: { runs: 20, seed: "author-sync-sequential-v1" } },
);

it.effect.prop(
  "generated offline batches keep superseded local versions and merge independent paths on reconnect",
  [
    Arbitrary.array(Arbitrary.schema(editorOperation), {
      minLength: 2,
      maxLength: 6,
    }),
  ],
  ([operations]) =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      yield* world.connect();
      yield* world.server.setOnline("a", false);
      yield* world.server.setOnline("b", false);
      const expected = new Map<string, string>();
      for (const [index, input] of operations.entries()) {
        const device = world[input.device];
        const path = `notes/${input.device}/${input.slot}.txt`;
        const content = `${index}:${input.content}`;
        yield* device.edit(path, content, "local-history");
        expect(Result.isFailure(yield* Effect.result(device.sync()))).toBe(true);
        expected.set(path, Buffer.from(content).toString("utf8"));
      }
      // Nothing has been sent. Superseded versions must already be readable locally.
      expect((yield* world.server.revisions()).length).toBe(1);
      yield* expectRecoverable(world);
      yield* world.server.setOnline("a", true);
      yield* world.server.setOnline("b", true);
      yield* world.a.sync();
      yield* world.b.sync();
      yield* world.a.sync();
      yield* expectRecoverable(world);
      yield* expectConverged(world);
      for (const [path, content] of expected) expect(yield* world.b.read(path)).toBe(content);
    }).pipe(Effect.provide(testPlatformLayer)),
  { arbitrary: { runs: 10, seed: "author-sync-offline-batches-v1" } },
);

it.effect.prop(
  "generated overlapping and independent same-file edits converge with every authored input online",
  [
    Arbitrary.array(
      Arbitrary.schema(
        Schema.Struct({
          a: Schema.String,
          b: Schema.String,
          first: Schema.Literals(["a", "b"]),
          insert: Schema.Boolean,
        }),
      ),
      { minLength: 1, maxLength: 3 },
    ),
  ],
  ([rounds]) =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      yield* world.connect();
      const path = "notes/shared.txt";
      const render = (shared: string, a: string, b: string) =>
        `shared: ${shared}\nseparator-one\na: ${a}\nseparator-two\nb: ${b}\n`;
      let shared = "initial",
        a = "initial",
        b = "initial";
      yield* world.a.edit(path, render(shared, a, b), "remote");
      yield* world.a.sync();
      yield* world.b.sync();
      for (const [index, round] of rounds.entries()) {
        const aInput = `A-${index}:${JSON.stringify(round.a)}`;
        const bInput = `B-${index}:${JSON.stringify(round.b)}`;
        const aNext = aInput + (round.insert ? `\nA insertion ${index}` : "");
        const bNext = bInput + (!round.insert ? `\nB insertion ${index}` : "");
        yield* world.server.setOnline("a", false);
        yield* world.server.setOnline("b", false);
        yield* world.a.edit(path, render(aInput, aNext, b), "remote");
        yield* world.b.edit(path, render(bInput, a, bNext), "remote");
        expect(Result.isFailure(yield* Effect.result(world.a.sync()))).toBe(true);
        expect(Result.isFailure(yield* Effect.result(world.b.sync()))).toBe(true);
        yield* world.server.setOnline("a", true);
        yield* world.server.setOnline("b", true);
        const first = world[round.first];
        const later = round.first === "a" ? world.b : world.a;
        yield* first.sync();
        yield* later.sync();
        yield* first.sync();
        // Both edits were made at the same instant, so the device that merges keeps its own.
        shared = round.first === "a" ? bInput : aInput;
        a = aNext;
        b = bNext;
        expect(yield* world.a.read(path)).toBe(render(shared, a, b));
        yield* expectConverged(world);
        yield* expectRecoverable(world);
      }
    }).pipe(Effect.provide(testPlatformLayer)),
  { arbitrary: { runs: 8, seed: "author-sync-overlapping-v1" } },
);

it.effect("an empty workspace blocks deletion until that removal is allowed", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    yield* world.connect();
    const before = yield* world.b.files();
    const revisions = (yield* world.server.revisions()).length;
    for (const file of yield* world.a.files()) yield* fs.remove(join(world.a.workspace, file.path));
    const blocked = {
      status: "blocked",
      changed: false,
      deleting: before.length,
      of: before.length,
      paths: before.map((file) => file.path).sort(),
    };
    expect(yield* world.a.sync()).toEqual(blocked);
    expect(yield* world.a.preview()).toEqual(blocked);
    yield* world.a.restart();
    expect(yield* world.a.sync()).toEqual(blocked);
    expect((yield* world.server.revisions()).length).toBe(revisions);
    yield* world.b.sync();
    expect(yield* world.b.files()).toEqual(before);
    // Approval is per invocation, never a persisted automatic preference.
    expect((yield* world.a.sync(false, true)).status).toBe("pushed");
    yield* world.b.sync();
    expect(yield* world.b.files()).toEqual([]);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("large partial deletion blocks while ordinary small deletion still syncs", () =>
  Effect.gen(function* () {
    const world = yield* makeAuthorSyncWorld();
    const fs = yield* FileSystem.FileSystem;
    yield* world.connect();
    for (let i = 0; i < 12; i++) yield* world.a.edit(`notes/${i}.txt`, "keep me");
    yield* world.a.sync();
    yield* world.b.sync();
    const before = yield* world.b.files();
    for (let i = 0; i < 8; i++) yield* fs.remove(join(world.a.workspace, `notes/${i}.txt`));
    expect(yield* world.a.sync()).toMatchObject({
      status: "blocked",
      deleting: 8,
      of: before.length,
    });
    yield* world.b.sync();
    expect(yield* world.b.files()).toEqual(before);
    // Restore three files: five deliberate removals are below the bulk guard.
    for (let i = 5; i < 8; i++) yield* world.a.edit(`notes/${i}.txt`, "keep me");
    expect((yield* world.a.sync()).status).toBe("pushed");
    yield* world.b.sync();
    yield* expectConverged(world);
  }).pipe(Effect.provide(testPlatformLayer)),
);
