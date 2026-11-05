import { Deferred, Effect, Fiber, FileSystem, Stream } from "effect";
import { it } from "@effect/vitest";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { join } from "node:path";
import { expect } from "vitest";
import { withLock as withHomeLock } from "../src/platform/home-lock.js";
import { acquireFileLock } from "../src/platform/file-lock.js";
import { skitLayer } from "../src/platform/layer.js";

/** Whether another holder could take the home lock now. */
const lockIsFree = (home: string) =>
  Effect.isSuccess(Effect.scoped(acquireFileLock(join(home, "lock.sqlite"))));

it.effect("fails at once while another process holds the lock, and not after it is killed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-writer-lock-held-" });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const holder = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
         new DatabaseSync(process.argv[1]).exec("BEGIN EXCLUSIVE;");
         process.stdout.write("held");
         setInterval(() => {}, 1000);`,
        join(home, "lock.sqlite"),
      ]),
    );
    yield* holder.stdout.pipe(Stream.take(1), Stream.runDrain);
    let ran = false;
    const program = Effect.sync(() => {
      ran = true;
    });
    expect(yield* Effect.flip(withHomeLock(home, program))).toMatchObject({
      _tag: "HomeBusy",
      path: join(home, "lock.sqlite"),
    });
    expect(ran).toBe(false);

    yield* holder.kill({ killSignal: "SIGKILL" });
    yield* holder.exitCode.pipe(Effect.ignore);
    yield* withHomeLock(home, program);
    expect(ran).toBe(true);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("ignores a .lock file left by an earlier SKIT", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-writer-lock-legacy-" });
    yield* fs.writeFileString(join(home, ".lock"), "999999999@elsewhere token\n");
    expect(yield* withHomeLock(home, Effect.succeed("ran"))).toBe("ran");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("releases the writer lock when the command fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-writer-lock-failure-" });
    yield* withHomeLock(home, Effect.fail("expected")).pipe(Effect.flip);
    expect(yield* lockIsFree(home)).toBe(true);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("queues writers within one process instead of failing them", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-writer-lock-queue-" });
    const imported = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const order: string[] = [];
    const first = yield* withHomeLock(
      home,
      Deferred.succeed(imported, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(Effect.sync(() => order.push("first"))),
      ),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(imported);
    const second = yield* withHomeLock(
      home,
      Effect.sync(() => order.push("second")),
    ).pipe(Effect.forkScoped);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    expect(order).toEqual(["first", "second"]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("makes a fiber that outlives its owner's lock acquire the lock again", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-writer-lock-detached-" });
    const released = yield* Deferred.make<void>();
    const child = yield* withHomeLock(
      home,
      Deferred.await(released).pipe(
        Effect.andThen(withHomeLock(home, Effect.void)),
        Effect.forkDetach,
      ),
    );
    // Another holder takes the lock once the owner has released it.
    yield* acquireFileLock(join(home, "lock.sqlite"));
    yield* Deferred.succeed(released, undefined);
    expect(yield* Effect.flip(Fiber.join(child))).toMatchObject({ _tag: "HomeBusy" });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("reuses writer authority within the owning fiber scope", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-writer-lock-reentrant-" });
    yield* withHomeLock(
      home,
      withHomeLock(
        home,
        Effect.gen(function* () {
          expect(yield* lockIsFree(home)).toBe(false);
        }),
      ),
    );
    expect(yield* lockIsFree(home)).toBe(true);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
