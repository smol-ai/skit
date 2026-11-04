import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { acquireFileLock, FileLockBusy } from "../src/platform/file-lock.js";

const lockPath = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return join(yield* fs.makeTempDirectoryScoped(), "lock.sqlite");
});

it.effect("a second hold fails at once while the first is held, and succeeds after", () =>
  Effect.gen(function* () {
    const path = yield* lockPath;
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* acquireFileLock(path);
        const second = yield* Effect.scoped(acquireFileLock(path)).pipe(Effect.flip);
        assert.instanceOf(second, FileLockBusy);
      }),
    );
    yield* Effect.scoped(acquireFileLock(path));
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
    const busy = yield* Effect.scoped(acquireFileLock(path)).pipe(Effect.flip);
    assert.instanceOf(busy, FileLockBusy);

    yield* holder.kill({ killSignal: "SIGKILL" });
    yield* holder.exitCode.pipe(Effect.ignore);
    yield* Effect.scoped(acquireFileLock(path));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "Bun and Node refuse each other's holds and release them after scope exit or SIGKILL",
  () =>
    Effect.gen(function* () {
      const path = yield* lockPath;
      const moduleUrl = new URL("../src/platform/file-lock.ts", import.meta.url).href;
      const script = `
      import { Effect } from "effect";
      import { acquireFileLock } from ${JSON.stringify(moduleUrl)};
      const result = await Effect.runPromise(Effect.scoped(
        acquireFileLock(process.argv[1]).pipe(Effect.as("free"),
          Effect.catchTag("FileLockBusy", () => Effect.succeed("busy")))));
      process.stdout.write(result);
    `;
      const probe = () => {
        const run = spawnSync("bun", ["-e", script, path], { encoding: "utf8", timeout: 5000 });
        assert.strictEqual(run.status, 0, run.stderr);
        return run.stdout;
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireFileLock(path);
          assert.strictEqual(probe(), "busy");
        }),
      );
      assert.strictEqual(probe(), "free");
      yield* Effect.scoped(acquireFileLock(path));

      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const holder = yield* spawner.spawn(
        ChildProcess.make("bun", [
          "-e",
          `
        import { Effect } from "effect";
        import { acquireFileLock } from ${JSON.stringify(moduleUrl)};
        await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
          yield* acquireFileLock(process.argv[1]);
          process.stdout.write("held");
          yield* Effect.never;
        })));
      `,
          path,
        ]),
      );
      yield* holder.stdout.pipe(Stream.take(1), Stream.runDrain);
      assert.instanceOf(
        yield* Effect.scoped(acquireFileLock(path)).pipe(Effect.flip),
        FileLockBusy,
      );
      yield* holder.kill({ killSignal: "SIGKILL" });
      yield* holder.exitCode.pipe(Effect.ignore);
      yield* Effect.scoped(acquireFileLock(path));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
