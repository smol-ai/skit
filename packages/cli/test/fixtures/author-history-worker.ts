import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, FileSystem, Schema, Stream } from "effect";
import { dirname, join } from "node:path";
import { authorLayer, refreshWorkspace } from "../../src/platform/author-sync-fixture/history.js";
import { testPlatformLayer } from "../helpers/platform.js";

const Arguments = Schema.Struct({
  mode: Schema.Literals(["record", "pause", "hold", "contend"]),
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
      let attempts = 0;
      // The owners are built over the controlled FileSystem, so capture runs through it.
      const controlled = refreshWorkspace(root).pipe(
        Effect.provide(authorLayer(home)),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          chmod: Effect.fn("Test.observeLockRetry")(function* (path, modeBits) {
            yield* fs.chmod(path, modeBits);
            if (mode === "contend" && path === join(directory, "journal.sqlite")) {
              attempts++;
              if (attempts === 2) yield* Console.log(JSON.stringify({ event: "retrying" }));
            }
          }),
          readFileString: Effect.fn("Test.pauseHistoryTransaction")(function* (path) {
            const bytes = yield* fs.readFileString(path);
            if (
              (mode === "pause" || mode === "hold") &&
              dirname(path) === join(directory, "trees") &&
              path.endsWith(".json")
            ) {
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
