import { Array, Effect, FileSystem, Layer, Option, Order, Path, Schema } from "effect";
import { hashHex, History, syncPaths, type Hash } from "@smolai/skit-core";
import { AuthorHistoryInvalid } from "./history-contracts.js";

/** Where the device stores trees or revisions: `trees` or `revisions` under `directory`. */
const storedFolder = (path: Path.Path, directory: string, kind: History.Kind) =>
  path.join(directory, kind === "tree" ? "trees" : "revisions");

/** Where the device stores one tree or revision: `<folder>/<hex>.json`. */
const storedPath = (path: Path.Path, directory: string, kind: History.Kind, hash: Hash) =>
  path.join(storedFolder(path, directory, kind), `${hashHex(hash)}.json`);

/**
 * Trees and revisions as files under `directory`, one JSON document per identity. A document is
 * flushed before it gets its final name, and only one writer can give it that name, so readers
 * never see a partial document and no writer can replace one that is already stored.
 */
const layerDeviceStore = (directory: string) =>
  Layer.effect(
    History.Store,
    Effect.gen(function* () {
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
    }),
  );

/**
 * Run `effect` against this device's history under `directory`. Stored history that cannot be
 * read back is unusable history, whatever the store's reason.
 */
export const withDeviceStore =
  (directory: string) =>
  <A, E, R>(effect: Effect.Effect<A, E | History.StoreError, R>) =>
    effect.pipe(
      Effect.provide(layerDeviceStore(directory)),
      Effect.catchIf(Schema.is(History.StoreError), (error) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          return yield* error._tag === "History.StoreFailed"
            ? new AuthorHistoryInvalid({ path: directory, reason: String(error.cause) })
            : new AuthorHistoryInvalid({
                path: storedPath(path, directory, error.kind, error.hash),
                reason:
                  error._tag === "History.StoreMissing" ? `${error.kind} is missing` : error.reason,
              });
        }),
      ),
    );
