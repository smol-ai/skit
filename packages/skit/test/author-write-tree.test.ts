import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { join } from "node:path";
import { scanAuthorSyncTree } from "../src/author/local-tree.js";
import { writeWorkspaceTree } from "../src/author/write-tree.js";
import * as History from "../src/history/history.js";
import { skitLayer } from "../src/platform/layer.js";

const files = (entries: Record<string, string>): History.Tree =>
  Object.entries(entries).map(([path, text]) => ({
    path,
    kind: "file",
    mode: 0o644,
    bytes: new TextEncoder().encode(text),
  }));
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "skit-structural-write-" }),
  );
  yield* fs.makeDirectory(join(root, ".skit"));
  const put = (tree: History.Tree) =>
    Effect.forEach(tree, (entry) =>
      Effect.gen(function* () {
        if (entry.kind !== "file") return;
        yield* fs.makeDirectory(join(root, entry.path, ".."), { recursive: true });
        yield* fs.writeFile(join(root, entry.path), entry.bytes);
      }),
    );
  return { fs, root, put };
});

for (const direction of ["file-to-directory", "directory-to-file"] as const)
  it.effect(`writes ${direction} including nested siblings and retries`, () =>
    Effect.gen(function* () {
      const { root, put } = yield* fixture;
      const one = files({ notes: "one", "unchanged.txt": "stay" });
      const many = files({ "notes/a.txt": "a", "notes/deep/b.txt": "b", "unchanged.txt": "stay" });
      const [from, to] = direction === "file-to-directory" ? [one, many] : [many, one];
      yield* put(from);
      yield* writeWorkspaceTree(root, from, to);
      expect(
        Schema.toEquivalence(History.Tree)(
          (yield* scanAuthorSyncTree(root)).tree,
          [...to].sort((a, b) => a.path.localeCompare(b.path)),
        ),
      ).toBe(true);
      yield* writeWorkspaceTree(root, to, to);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("an empty directory left by an interrupted replacement remains replaceable", () =>
  Effect.gen(function* () {
    const { fs, root } = yield* fixture;
    yield* fs.makeDirectory(join(root, "notes/deep"), { recursive: true });
    const to = files({ notes: "recovered" });
    yield* writeWorkspaceTree(root, [], to);
    expect(Schema.toEquivalence(History.Tree)((yield* scanAuthorSyncTree(root)).tree, to)).toBe(
      true,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const kind of ["file", "directory", "symlink"] as const)
  it.effect(`ignored ${kind} blocks directory replacement before source bytes are removed`, () =>
    Effect.gen(function* () {
      const { fs, root, put } = yield* fixture;
      yield* put(files({ "notes/a.txt": "reviewed", ".gitignore": "notes/private\n" }));
      const privatePath = join(root, "notes/private");
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "skit-private-target-" });
      const secret = join(outside, "secret.txt");
      yield* fs.writeFileString(secret, "private");
      if (kind === "directory") yield* fs.makeDirectory(privatePath);
      else if (kind === "symlink") yield* fs.symlink(secret, privatePath);
      else yield* fs.writeFileString(privatePath, "private");
      const from = (yield* scanAuthorSyncTree(root)).tree;
      expect(
        yield* Effect.flip(
          writeWorkspaceTree(root, from, files({ notes: "new", ".gitignore": "notes/private\n" })),
        ),
      ).toMatchObject({ _tag: "AuthorLocalPathUnchecked", path: "notes/private" });
      expect(yield* fs.readFileString(join(root, "notes/a.txt"))).toBe("reviewed");
      expect(yield* fs.readFileString(secret)).toBe("private");
      if (kind === "directory") expect((yield* fs.stat(privatePath)).type).toBe("Directory");
      else expect(yield* fs.readFileString(privatePath)).toBe("private");
      if (kind === "symlink") expect(yield* fs.readLink(privatePath)).toBe(secret);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

for (const race of ["new-parent", "new-child", "new-target"] as const)
  it.effect(`preserves an editor's ${race} inserted during structural replacement`, () =>
    Effect.gen(function* () {
      const { fs, root, put } = yield* fixture;
      const from =
        race === "new-parent" ? files({ notes: "old" }) : files({ "notes/a.txt": "old" });
      const to = race === "new-parent" ? files({ "notes/a.txt": "new" }) : files({ notes: "new" });
      yield* put(from);
      let inserted = false;
      const raced: FileSystem.FileSystem = {
        ...fs,
        remove: (target, options) =>
          Effect.gen(function* () {
            yield* fs.remove(target, options);
            if (inserted || target !== join(root, race === "new-parent" ? "notes" : "notes/a.txt"))
              return;
            if (race === "new-target") return;
            inserted = true;
            yield* fs.writeFileString(
              join(root, race === "new-parent" ? "notes" : "notes/private.txt"),
              "editor",
            );
          }),
        link: (from, target) =>
          Effect.gen(function* () {
            if (!inserted && race === "new-target" && target === join(root, "notes")) {
              inserted = true;
              yield* fs.writeFileString(target, "editor");
            }
            yield* fs.link(from, target);
          }),
      };
      const exit = yield* Effect.exit(
        writeWorkspaceTree(root, from, to).pipe(
          Effect.provideService(FileSystem.FileSystem, raced),
        ),
      );
      expect(exit._tag).toBe("Failure");
      expect(inserted).toBe(true);
      expect(
        yield* fs.readFileString(join(root, race === "new-child" ? "notes/private.txt" : "notes")),
      ).toBe("editor");
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("refuses a file/descendant target before staging or mutating files", () =>
  Effect.gen(function* () {
    const { fs, root, put } = yield* fixture;
    const from = files({ original: "untouched" });
    yield* put(from);
    expect(
      yield* Effect.flip(
        writeWorkspaceTree(root, from, files({ notes: "parent", "notes/a.txt": "child" })),
      ),
    ).toMatchObject({ _tag: "SkitContractError", contract: "Author sync tree" });
    expect(yield* fs.readFileString(join(root, "original"))).toBe("untouched");
    expect(yield* fs.readDirectory(join(root, ".skit"))).toEqual([]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
