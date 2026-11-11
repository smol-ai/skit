import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Schema } from "effect";
import { join } from "node:path";
import { deterministicTreeHash } from "../src/artifact/skit.js";
import { LinkStat } from "../src/platform/link-stat.js";
import { scanAuthorTree, normalizeAuthorTreeEntries } from "../src/artifact/tree.js";
import { TreeError } from "../src/shared/tree-error.js";
import { skitLayer } from "../src/platform/layer.js";

it.effect("physical identity changes do not change the content hash or native filename", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const links = yield* LinkStat;
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-native-" });
    const root = join(temporary, "author");
    yield* fs.makeDirectory(root);
    const native = "cafe\u0301.txt";
    const path = join(root, native);
    yield* fs.writeFileString(path, "same bytes\n");
    const before = yield* scanAuthorTree(root);
    const rootInfo = yield* links.identity.lstat(root);
    const fileInfo = yield* links.identity.lstat(path);
    expect(before.identities.get("")).toEqual({ dev: rootInfo.dev, ino: rootInfo.ino });
    expect(before.identities.get(native)).toEqual({ dev: fileInfo.dev, ino: fileInfo.ino });
    const hash = yield* deterministicTreeHash(root);
    const replacement = join(temporary, "replacement");
    yield* fs.writeFileString(replacement, "same bytes\n");
    yield* fs.rename(replacement, path);
    const after = yield* scanAuthorTree(root);
    expect(after.entries.map((entry) => entry.path)).toEqual([native]);
    expect(after.identities.get(native)).not.toEqual(before.identities.get(native));
    expect(yield* deterministicTreeHash(root)).toBe(hash);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a native identity scan refuses a symlink root before reading its files", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-root-link-" });
    yield* fs.makeDirectory(join(temporary, "source"));
    yield* fs.writeFileString(join(temporary, "source/private"), "do not read\n");
    const root = join(temporary, "alias");
    yield* fs.symlink(join(temporary, "source"), root);
    const failure = yield* Effect.flip(
      scanAuthorTree(root).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFile: () => Effect.die("followed a symlink root"),
        }),
      ),
    );
    expect(failure).toMatchObject({
      _tag: "TreeError",
      reason: { _tag: "RootNotDirectory", entryType: "SymbolicLink", path: root },
    });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "normalization collisions keep both original names and their shared normalized path",
  () =>
    Effect.gen(function* () {
      const names = ["caf\u00e9.txt", "cafe\u0301.txt"];
      const failure = yield* Effect.flip(
        normalizeAuthorTreeEntries(
          names.map((path) => ({
            kind: "file" as const,
            path,
            bytes: new Uint8Array([1]),
            mode: 0o644 as const,
          })),
        ),
      );
      expect(failure.reason).toEqual({
        _tag: "NormalizedPathCollision",
        path: names[0],
        firstPath: names[0],
        secondPath: names[1],
      });
      const wire = yield* Schema.encodeEffect(TreeError)(failure);
      expect(
        yield* Schema.decodeUnknownEffect(TreeError)(JSON.parse(JSON.stringify(wire))),
      ).toEqual(failure);
    }),
);

it.effect("a missing root identity is a typed failure before any contents are read", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const links = yield* LinkStat;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-no-inode-" });
    const failure = yield* Effect.flip(
      scanAuthorTree(root).pipe(
        Effect.provideService(LinkStat, {
          ...links,
          lstat: (path) =>
            links.lstat(path).pipe(Effect.map((info) => ({ ...info, ino: Option.none() }))),
        }),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readDirectory: () => Effect.die("Read contents without a root identity"),
        }),
      ),
    );
    expect(failure).toMatchObject({
      _tag: "TreeError",
      reason: { _tag: "NativeIdentityMissing", entryType: "Directory", path: root },
    });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
