import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import { errorMessage } from "../src/shared/failure.js";
import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Stream, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { lockFile, FileLockBusy, FileLockFailed } from "../src/platform/file-lock.js";

const lockPath = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return join(yield* fs.makeTempDirectoryScoped(), "lock.sqlite");
});

it.effect("a second hold fails at once while the first is held, and succeeds after", () =>
  Effect.gen(function* () {
    const path = yield* lockPath;
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* lockFile(path);
        const second = yield* Effect.scoped(lockFile(path)).pipe(Effect.flip);
        assert.instanceOf(second, FileLockBusy);
      }),
    );
    yield* Effect.scoped(lockFile(path));
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
    const busy = yield* Effect.scoped(lockFile(path)).pipe(Effect.flip);
    assert.instanceOf(busy, FileLockBusy);

    yield* holder.kill({ killSignal: "SIGKILL" });
    yield* holder.exitCode.pipe(Effect.ignore);
    yield* Effect.scoped(lockFile(path));
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
      import { lockFile } from ${JSON.stringify(moduleUrl)};
      const result = await Effect.runPromise(Effect.scoped(
        lockFile(process.argv[1]).pipe(Effect.as("free"),
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
          yield* lockFile(path);
          assert.strictEqual(probe(), "busy");
        }),
      );
      assert.strictEqual(probe(), "free");
      yield* Effect.scoped(lockFile(path));

      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const holder = yield* spawner.spawn(
        ChildProcess.make("bun", [
          "-e",
          `
        import { Effect } from "effect";
        import { lockFile } from ${JSON.stringify(moduleUrl)};
        await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
          yield* lockFile(process.argv[1]);
          process.stdout.write("held");
          yield* Effect.never;
        })));
      `,
          path,
        ]),
      );
      yield* holder.stdout.pipe(Stream.take(1), Stream.runDrain);
      assert.instanceOf(yield* Effect.scoped(lockFile(path)).pipe(Effect.flip), FileLockBusy);
      yield* holder.kill({ killSignal: "SIGKILL" });
      yield* holder.exitCode.pipe(Effect.ignore);
      yield* Effect.scoped(lockFile(path));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a non-SQLite lock retains native driver facts through JSON", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* lockPath;
    yield* fs.writeFileString(path, "not a sqlite database\n");
    const failure = yield* Effect.scoped(lockFile(path)).pipe(Effect.flip);
    assert.instanceOf(failure, FileLockFailed);
    if (failure._tag !== "FileLockFailed") return;
    assert.deepInclude(failure.cause, { errcode: 26 });
    assert.include(errorMessage(failure.cause), "file is not a database");
    const wire = Schema.encodeSync(FileLockFailed)(failure);
    const decoded = Schema.decodeUnknownSync(FileLockFailed)(JSON.parse(JSON.stringify(wire)));
    assert.deepInclude(decoded.cause, { errcode: 26 });
    assert.strictEqual(errorMessage(decoded.cause), errorMessage(failure.cause));
    const moduleUrl = new URL("../src/platform/file-lock.ts", import.meta.url).href;
    const probe = spawnSync(
      "bun",
      [
        "-e",
        `
      import { Effect, Schema } from "effect";
      import { lockFile, FileLockFailed } from ${JSON.stringify(moduleUrl)};
      const failure = await Effect.runPromise(Effect.scoped(lockFile(process.argv[1])).pipe(Effect.flip));
      process.stdout.write(JSON.stringify(Schema.encodeUnknownSync(FileLockFailed)(failure)));
    `,
        path,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.strictEqual(probe.status, 0, probe.stderr);
    const bunFailure = Schema.decodeUnknownSync(FileLockFailed)(JSON.parse(probe.stdout));
    assert.deepInclude(bunFailure.cause, { errno: 26 });
    assert.include(errorMessage(bunFailure.cause), "file is not a database");
    assert.strictEqual(yield* fs.readFileString(path), "not a sqlite database\n");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("live lock failures preserve the exact native thrown value after scope cleanup", () =>
  Effect.gen(function* () {
    const path = yield* lockPath;
    for (const original of [
      Object.assign(new Error("native failure", { cause: new Error("underlying") }), {
        code: "SQLITE_CUSTOM",
        errcode: 26,
      }),
      { message: "native failure", errno: null },
      "native failure",
    ]) {
      const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementationOnce(() => {
        throw original;
      });
      try {
        const failure = yield* Effect.scoped(lockFile(path)).pipe(Effect.flip);
        assert.instanceOf(failure, FileLockFailed);
        if (failure._tag !== "FileLockFailed") continue;
        assert.strictEqual(failure.cause, original);
        const encoded = Schema.encodeSync(FileLockFailed)(failure);
        const loaded = Schema.decodeUnknownSync(FileLockFailed)(
          JSON.parse(JSON.stringify(encoded)),
        );
        assert.strictEqual(errorMessage(loaded.cause), "native failure");
        if (typeof original !== "string") {
          for (const [key, value] of Object.entries(original)) {
            if (key !== "cause") assert.deepInclude(loaded.cause, { [key]: value });
          }
        }
      } finally {
        exec.mockRestore();
      }
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
