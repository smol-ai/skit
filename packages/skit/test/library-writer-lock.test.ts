import { Deferred, Effect, Fiber, FileSystem } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { withLibraryWriterLock } from "../src/library/store/writer-lock.js";
import { skitLayer } from "../src/index.js";

it.effect("fails closed on a lock another process left, naming it and keeping it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-writer-lock-held-" });
    // A PID that cannot be running is still not proof the lock is abandoned.
    yield* fs.writeFileString(`${home}/.lock`, "999999999@elsewhere token\n");
    expect(yield* Effect.flip(withLibraryWriterLock(home, Effect.void))).toMatchObject({
      _tag: "LibraryBusy",
      path: `${home}/.lock`,
      owner: "999999999@elsewhere",
    });
    expect(yield* fs.readFileString(`${home}/.lock`)).toBe("999999999@elsewhere token\n");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("releases the writer lock when the command fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-writer-lock-failure-" });
    yield* withLibraryWriterLock(home, Effect.fail("expected")).pipe(Effect.flip);
    expect(yield* fs.exists(`${home}/.lock`)).toBe(false);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("does not release a lock it did not create", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-writer-lock-foreign-" });
    yield* withLibraryWriterLock(
      home,
      // Someone removed this lock by hand and another writer took it meanwhile.
      fs.writeFileString(`${home}/.lock`, "1@elsewhere other-token\n"),
    );
    expect(yield* fs.readFileString(`${home}/.lock`)).toBe("1@elsewhere other-token\n");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("queues writers within one process instead of failing them", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-writer-lock-queue-" });
    const imported = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const order: string[] = [];
    const first = yield* withLibraryWriterLock(
      home,
      Deferred.succeed(imported, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(Effect.sync(() => order.push("first"))),
      ),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(imported);
    const second = yield* withLibraryWriterLock(
      home,
      Effect.sync(() => order.push("second")),
    ).pipe(Effect.forkScoped);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    expect(order).toEqual(["first", "second"]);
    expect(yield* fs.exists(`${home}/.lock`)).toBe(false);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("makes a fiber that outlives its owner's lock acquire the lock again", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-writer-lock-detached-" });
    const released = yield* Deferred.make<void>();
    const child = yield* withLibraryWriterLock(
      home,
      Deferred.await(released).pipe(
        Effect.andThen(withLibraryWriterLock(home, Effect.void)),
        Effect.forkDetach,
      ),
    );
    yield* fs.writeFileString(`${home}/.lock`, "4242@elsewhere token\n");
    yield* Deferred.succeed(released, undefined);
    expect(yield* Effect.flip(Fiber.join(child))).toMatchObject({ _tag: "LibraryBusy" });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("reuses writer authority within the owning fiber scope", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-writer-lock-reentrant-" });
    yield* withLibraryWriterLock(
      home,
      withLibraryWriterLock(
        home,
        Effect.gen(function* () {
          expect(yield* fs.exists(`${home}/.lock`)).toBe(true);
        }),
      ),
    );
    expect(yield* fs.exists(`${home}/.lock`)).toBe(false);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
