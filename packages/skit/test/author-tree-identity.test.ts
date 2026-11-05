import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { deterministicTreeHash } from "../src/artifact/skit.js";
import { LinkStat } from "../src/platform/link-stat.js";
import { scanAuthorTree } from "../src/artifact/tree.js";
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
      reason: { _tag: "CannotRetain", path: "." },
    });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
