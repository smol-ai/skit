/**
 * AuthorHistory's tree and revision store, private to the owner (architecture/author.ts): trees
 * and revisions as files under `<home>/history`, one JSON document per identity.
 */
import { Array, Effect, FileSystem, Option, Order, Path } from "effect";
import { hashHex, type Hash } from "../shared/hash.js";
import * as History from "../history/history.js";
import { syncPaths } from "../platform/atomic-write.js";

/** Where the device stores trees or revisions: `trees` or `revisions` under `directory`. */
const storedFolder = (path: Path.Path, directory: string, kind: History.Kind) =>
  path.join(directory, kind === "tree" ? "trees" : "revisions");

/** Where the device stores one tree or revision: `<folder>/<hex>.json`. */
export const storedPath = (path: Path.Path, directory: string, kind: History.Kind, hash: Hash) =>
  path.join(storedFolder(path, directory, kind), `${hashHex(hash)}.json`);

/**
 * A History.Store over `directory`. A document is flushed before it gets its final name, and only
 * one writer can give it that name, so readers never see a partial document and no writer can
 * replace one that is already stored.
 */
export const makeHistoryStore = Effect.fn("AuthorHistory.makeStore")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const failed = (cause: unknown) => new History.StoreFailed({ cause });
  return yield* History.makeStore({
    read: (kind, hash) =>
      fs.readFileString(storedPath(path, directory, kind, hash)).pipe(
        Effect.map(Option.some),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
        Effect.mapError(failed),
      ),
    write: (kind, hash, text) =>
      Effect.gen(function* () {
        const stored = storedPath(path, directory, kind, hash);
        const parent = path.dirname(stored);
        if (!(yield* fs.exists(stored))) {
          yield* fs.makeDirectory(parent, { recursive: true, mode: 0o700 });
          // Existing atomic-write helpers publish complete files but do not flush file
          // contents. Here a write must be durable before sync proceeds. Link a flushed file
          // exclusively; concurrent writers cannot truncate or replace a stored document.
          yield* Effect.scoped(
            Effect.gen(function* () {
              const staging = yield* fs.makeTempDirectoryScoped({
                directory: parent,
                prefix: ".pending-",
              });
              const temporary = path.join(staging, "document.json");
              const file = yield* fs.open(temporary, { flag: "wx", mode: 0o600 });
              yield* file.writeAll(new TextEncoder().encode(text));
              yield* file.sync;
              yield* fs.link(temporary, stored).pipe(
                Effect.uninterruptible,
                Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void),
              );
            }),
          );
        }
        // Also flush when the file exists: another writer may have just linked it but not
        // flushed its directory yet.
        yield* syncPaths([
          parent,
          directory,
          path.dirname(directory),
          path.dirname(path.dirname(directory)),
        ]).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      }).pipe(Effect.mapError(failed)),
    has: (kind, hash) =>
      fs.exists(storedPath(path, directory, kind, hash)).pipe(Effect.mapError(failed)),
    list: (kind) =>
      fs.readDirectory(storedFolder(path, directory, kind)).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
        Effect.map((names) =>
          Array.sort(
            names
              .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
              .map((name): Hash => `sha256:${name.slice(0, 64)}`),
            Order.String,
          ),
        ),
        Effect.mapError(failed),
      ),
  });
});
