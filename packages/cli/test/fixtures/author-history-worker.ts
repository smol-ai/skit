import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, FileSystem, Schema, Stream } from "effect";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { authorLayer, refreshWorkspace } from "../../src/platform/author-sync-fixture/history.js";
import { testPlatformLayer } from "../helpers/platform.js";

const Arguments = Schema.Struct({
  mode: Schema.Literals(["record", "pause", "hold", "contend", "stage"]),
  root: Schema.String,
  home: Schema.String,
});
NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const { mode, root, home } = yield* Schema.decodeUnknownEffect(Arguments)({
        mode: process.argv[2],
        root: process.argv[3],
        home: process.argv[4],
      });
      const fs = yield* FileSystem.FileSystem;
      const directory = join(home, "history");
      const database = join(home, "library.sqlite");
      const treeCount = () => {
        const sql = new DatabaseSync(database, { readOnly: true });
        try {
          if (!sql.prepare("SELECT name FROM sqlite_master WHERE name='author_trees'").get())
            return 0;
          return Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Int }))(
            sql.prepare("SELECT COUNT(*) AS count FROM author_trees").get(),
          ).count;
        } finally {
          sql.close();
        }
      };
      const beforeTrees = (yield* fs.exists(database)) ? treeCount() : 0;
      let attempts = 0;
      let paused = false;
      // The owners are built over the controlled FileSystem, so capture runs through it.
      const controlled = refreshWorkspace(root).pipe(
        Effect.provide(authorLayer(home)),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          open: Effect.fn("Test.pauseByteStaging")(function* (path, options) {
            const handle = yield* fs.open(path, options);
            if (mode === "stage" && !paused && path.endsWith("/bytes") && options?.flag === "wx") {
              paused = true;
              yield* Console.log(JSON.stringify({ event: "paused" }));
              yield* Stream.fromAsyncIterable(process.stdin, (cause) => cause).pipe(
                Stream.take(1),
                Stream.runDrain,
                Effect.orDie,
              );
            }
            return handle;
          }),
          chmod: Effect.fn("Test.observeLockRetry")(function* (path, modeBits) {
            yield* fs.chmod(path, modeBits);
            if (mode === "contend" && path === join(directory, "lock.sqlite")) {
              attempts++;
              if (attempts === 2) yield* Console.log(JSON.stringify({ event: "retrying" }));
            }
          }),
          readFile: Effect.fn("Test.pauseBeforeHistoryEvent")(function* (path) {
            const bytes = yield* fs.readFile(path);
            if (
              (mode === "pause" || mode === "hold") &&
              !paused &&
              dirname(path) === join(home, "file-bytes") &&
              (yield* fs.exists(database)) &&
              treeCount() > beforeTrees
            ) {
              paused = true;
              yield* Console.log(JSON.stringify({ event: "paused" }));
              if (mode === "pause") return yield* Effect.never;
              else
                yield* Stream.fromAsyncIterable(process.stdin, (cause) => cause).pipe(
                  Stream.take(1),
                  Stream.runDrain,
                  Effect.orDie,
                );
            }
            return bytes;
          }),
        }),
      );
      yield* controlled.pipe(
        Effect.catchTag("AuthorHistoryBusy", (error) =>
          Console.log(
            JSON.stringify({
              event: "busy",
              code: error.code,
              retryable: error.retryable,
            }),
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(testPlatformLayer)),
);
