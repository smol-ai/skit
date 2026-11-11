import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as History from "@smolai/skit-core/history";
import { authorLayer as owners, refreshAuthorWorkspace } from "@smolai/skit-core/author";

export const authorLayer = (home: string) => Layer.fresh(owners({ home }));
export const refreshWorkspace = refreshAuthorWorkspace;

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    schema: Schema.Literal("skit.author-tree.v1"),
    entries: Schema.Array(
      Schema.Union([
        Schema.Struct({
          kind: Schema.Literal("file"),
          path: Schema.String,
          mode: Schema.Literals([0o644, 0o755]),
          blob: Schema.String,
        }),
        Schema.Struct({ kind: Schema.Literal("directory"), path: Schema.String }),
        Schema.Struct({
          kind: Schema.Literal("symlink"),
          path: Schema.String,
          target: Schema.String,
        }),
      ]),
    ),
  }),
);

/** Independent, read-only disk evidence. It cannot obtain an Author lease or mutate a store. */
const historyAt = Effect.fn("Fixture.historyEvidence")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const folder = (kind: History.Kind) =>
    join(home, "history", kind === "tree" ? "trees" : "revisions");
  const failed = (cause: unknown) => new History.StoreFailed({ cause });
  const store = yield* History.makeStore({
    read: (kind, hash) =>
      Effect.gen(function* () {
        const text = yield* fs.readFileString(join(folder(kind), `${hash.slice(7)}.json`)).pipe(
          Effect.asSome,
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
          Effect.mapError(failed),
        );
        if (kind !== "tree" || Option.isNone(text)) return text;
        const manifest = Schema.decodeOption(Manifest)(text.value);
        if (Option.isNone(manifest)) return text; // Legacy byte-bearing trees and malformed documents go through the canonical verifier.
        const tree = yield* Effect.forEach(manifest.value.entries, (entry) =>
          Effect.gen(function* () {
            if (entry.kind !== "file") return entry;
            const bytes = yield* fs
              .readFile(join(home, "history", "blobs", entry.blob.slice(7)))
              .pipe(Effect.mapError(failed));
            if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== entry.blob)
              return yield* new History.StoreCorrupt({
                kind,
                hash,
                reason: {
                  _tag: "BlobHashMismatch",
                  blob: entry.blob,
                  actual: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
                },
              });
            return { kind: entry.kind, path: entry.path, mode: entry.mode, bytes };
          }),
        );
        return Option.some(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(History.Tree)))(
            tree,
          ).pipe(Effect.orDie),
        );
      }),
    write: () => Effect.die("History evidence is read-only"),
    has: (kind, hash) =>
      fs.exists(join(folder(kind), `${hash.slice(7)}.json`)).pipe(Effect.mapError(failed)),
    list: (kind) =>
      fs.readDirectory(folder(kind)).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
        Effect.flatMap((names) =>
          Effect.forEach(names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort(), (name) =>
            Schema.decodeEffect(History.TreeHash)(`sha256:${name.slice(0, -5)}`),
          ),
        ),
        Effect.mapError(failed),
      ),
  });
  return store;
});

export const storedTreesAt = (home: string) =>
  Effect.gen(function* () {
    const store = yield* historyAt(home);
    return yield* Effect.forEach(yield* store.trees, (hash) =>
      Effect.map(store.tree(hash), (tree) => ({ hash, tree })),
    );
  });
export const readAuthorTree = (
  observation: { readonly treeHash: History.TreeHash },
  home: string,
) => Effect.flatMap(historyAt(home), (store) => store.tree(observation.treeHash));
export const readAuthorRevision = (home: string, id: History.RevisionId) =>
  Effect.flatMap(historyAt(home), (store) => store.revision(id));
export const readAuthorAncestors = (home: string, id: History.RevisionId) =>
  Effect.flatMap(historyAt(home), (store) => Stream.runCollect(History.ancestors(store, id)));
