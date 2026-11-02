import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { scanAuthorSyncTree } from "../src/workflows/author/local-tree.js";
import { testPlatformLayer } from "./helpers/platform.js";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "skit-native-target-" });
  const root = join(temporary, "root");
  yield* fs.makeDirectory(join(root, "notes"), { recursive: true });
  yield* fs.writeFileString(join(root, "notes/a.txt"), "same bytes\n");
  return { fs, temporary, root };
});

it.effect.each([
  "../escape",
  "/absolute",
  "notes//a.txt",
  "notes\\a.txt",
  ".git/config",
  ".skit/workspace.json",
  "skit.remote.json",
])("the write owner refuses an unsafe or control target %s", (path) =>
  Effect.gen(function* () {
    const { root } = yield* fixture;
    const tree = yield* scanAuthorSyncTree(root);
    expect(yield* Effect.flip(tree.checkTarget(path))).toMatchObject({
      _tag: "SkitContractError",
      contract: "Author write target",
    });
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect.each(["file", "parent", "root"] as const)(
  "replacement of the recorded %s identity is refused even when bytes are identical",
  (kind) =>
    Effect.gen(function* () {
      const { fs, root, temporary } = yield* fixture;
      const tree = yield* scanAuthorSyncTree(root);
      if (kind === "file") {
        const replacement = join(temporary, "replacement");
        yield* fs.writeFileString(replacement, "same bytes\n");
        yield* fs.rename(replacement, join(root, "notes/a.txt"));
      } else if (kind === "parent") {
        yield* fs.rename(join(root, "notes"), join(root, "old-notes"));
        yield* fs.makeDirectory(join(root, "notes"));
        yield* fs.writeFileString(join(root, "notes/a.txt"), "same bytes\n");
      } else {
        yield* fs.rename(root, join(temporary, "old-root"));
        yield* fs.makeDirectory(join(root, "notes"), { recursive: true });
        yield* fs.writeFileString(join(root, "notes/a.txt"), "same bytes\n");
      }
      expect(yield* Effect.flip(tree.checkTarget("notes/a.txt"))).toMatchObject({
        _tag: "LocalFilesChangedDuringSync",
      });
      expect(yield* fs.readFileString(join(root, "notes/a.txt"))).toBe("same bytes\n");
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("normal missing parents remain writable after they are created", () =>
  Effect.gen(function* () {
    const { fs, root } = yield* fixture;
    const tree = yield* scanAuthorSyncTree(root);
    const target = join(root, "notes/new/deep.txt");
    expect(yield* tree.checkTarget("notes/new/deep.txt")).toBe(target);
    yield* fs.makeDirectory(join(root, "notes/new"));
    expect(yield* tree.checkTarget("notes/new/deep.txt")).toBe(target);
    yield* fs.writeFileString(target, "unrecorded editor save\n");
    expect(yield* Effect.flip(tree.checkTarget("notes/new/deep.txt"))).toMatchObject({
      _tag: "AuthorLocalPathNotObserved",
    });
    expect(yield* fs.readFileString(target)).toBe("unrecorded editor save\n");
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("atomic replacement during capture cannot pair old inode authority with new bytes", () =>
  Effect.gen(function* () {
    const { fs, root, temporary } = yield* fixture;
    const path = join(root, "notes/a.txt");
    let replaced = false;
    const result = yield* Effect.flip(
      scanAuthorSyncTree(root).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFile: Effect.fn("Test.replaceDuringIdentityCapture")(function* (input) {
            if (input === path && !replaced) {
              replaced = true;
              const replacement = join(temporary, "replacement");
              yield* fs.writeFileString(replacement, "new editor bytes\n");
              yield* fs.rename(replacement, path);
            }
            return yield* fs.readFile(input);
          }),
        }),
      ),
    );
    expect(result).toMatchObject({ _tag: "LocalFilesChangedDuringSync" });
    expect(yield* fs.readFileString(path)).toBe("new editor bytes\n");
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
