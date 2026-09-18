import { Deferred, Effect, Fiber, FileSystem } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { withLibraryWriterLock } from "../src/library/store/writer-lock.js";
import { skitLayer } from "../src/index.js";

it.effect("holds one scoped writer lock for a Library home", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-writer-lock-" });
    const acquired = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const owner = yield* withLibraryWriterLock(
      home,
      Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ).pipe(Effect.forkScoped);

    yield* Deferred.await(acquired);
    expect(yield* Effect.flip(withLibraryWriterLock(home, Effect.void))).toMatchObject({
      _tag: "LibraryBusy",
      path: `${home}/.lock`,
    });

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(owner);
    expect(yield* fs.exists(`${home}/.lock`)).toBe(false);
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

it.effect("reclaims a lock left by a dead process", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-writer-lock-stale-" });
    yield* fs.writeFileString(`${home}/.lock`, "999999999\n");
    yield* withLibraryWriterLock(home, Effect.void);
    expect(yield* fs.exists(`${home}/.lock`)).toBe(false);
    expect((yield* fs.readDirectory(home)).some((name) => name.startsWith(".lock-stale-"))).toBe(
      false,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("does not steal an ownership file without a provably dead PID", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-writer-lock-unknown-" });
    yield* fs.writeFileString(`${home}/.lock`, "");
    expect(yield* Effect.flip(withLibraryWriterLock(home, Effect.void))).toMatchObject({
      _tag: "LibraryBusy",
      path: `${home}/.lock`,
    });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
