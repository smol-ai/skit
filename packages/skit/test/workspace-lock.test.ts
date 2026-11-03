import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { join } from "node:path";
import { acquireWorkspaceLock, WorkspaceLockBusy } from "../src/platform/workspace-lock.js";

const lockPath = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return join(yield* fs.makeTempDirectoryScoped(), "lock.sqlite");
});

it.effect("a second hold fails at once while the first is held, and succeeds after", () =>
  Effect.gen(function* () {
    const path = yield* lockPath;
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* acquireWorkspaceLock(path);
        const second = yield* Effect.scoped(acquireWorkspaceLock(path)).pipe(Effect.flip);
        assert.instanceOf(second, WorkspaceLockBusy);
      }),
    );
    yield* Effect.scoped(acquireWorkspaceLock(path));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a process killed while holding the lock does not leave it held", () =>
  Effect.gen(function* () {
    const path = yield* lockPath;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const holder = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
         new DatabaseSync(process.argv[1]).exec("BEGIN EXCLUSIVE;");
         process.stdout.write("held");
         setInterval(() => {}, 1000);`,
        path,
      ]),
    );
    yield* holder.stdout.pipe(Stream.take(1), Stream.runDrain);
    const busy = yield* Effect.scoped(acquireWorkspaceLock(path)).pipe(Effect.flip);
    assert.instanceOf(busy, WorkspaceLockBusy);

    yield* holder.kill({ killSignal: "SIGKILL" });
    yield* holder.exitCode.pipe(Effect.ignore);
    yield* Effect.scoped(acquireWorkspaceLock(path));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
