import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, expect, vi } from "vitest";
import { consoleRenderer } from "../src/presentation/renderer.js";

const originalTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
afterEach(() => {
  vi.restoreAllMocks();
  if (originalTTY) Object.defineProperty(process.stderr, "isTTY", originalTTY);
  else Reflect.deleteProperty(process.stderr, "isTTY");
});

const capture = (tty: boolean) => {
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: tty });
  const writes: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk, ...args) => {
    writes.push(String(chunk));
    const callback = args.find((value) => typeof value === "function");
    if (typeof callback === "function") callback();
    return true;
  });
  return writes;
};

it.effect("resumes changing status after printing a plan and clears it on failure", () =>
  Effect.gen(function* () {
    const writes = capture(true);
    const renderer = consoleRenderer(false);
    const ready = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const fiber = yield* renderer
      .withStatus(
        "Planning",
        Effect.gen(function* () {
          yield* renderer.note("One Collection to add", "Library sync plan");
          yield* renderer.updateStatus("Downloading Skill copies · 1/2");
          yield* Deferred.succeed(ready, undefined);
          yield* Deferred.await(finish);
          return yield* Effect.fail("download failed");
        }),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(ready);
    yield* TestClock.adjust(80);
    expect(writes.join("")).toContain("Library sync plan");
    expect(writes.join("")).toContain("Downloading Skill copies · 1/2");
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(fiber).pipe(Effect.flip);
    expect(writes.at(-1)).toBe("\r\u001b[2K");
  }),
);

for (const [json, tty] of [
  [true, true],
  [false, false],
] as const) {
  it.effect(`suppresses transient status for json=${json}, tty=${tty}`, () =>
    Effect.gen(function* () {
      const writes = capture(tty);
      const renderer = consoleRenderer(json);
      const value = yield* renderer.withStatus(
        "Syncing",
        renderer.updateStatus("Downloading").pipe(Effect.as(42)),
      );
      expect(value).toBe(42);
      expect(writes).toEqual([]);
    }),
  );
}

for (const tty of [true, false]) {
  it.effect(`persists a completed step with elapsed time (tty=${tty})`, () =>
    Effect.gen(function* () {
      const writes = capture(tty);
      const renderer = consoleRenderer(false);
      const ready = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const fiber = yield* renderer
        .withStatus(
          {
            pending: "Fetching example/skills",
            complete: "Fetched example/skills",
            persist: "timed",
          },
          Deferred.succeed(ready, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.as(42),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(ready);
      yield* TestClock.adjust(2350);
      yield* Deferred.succeed(finish, undefined);
      expect(yield* Fiber.join(fiber)).toBe(42);
      expect(writes.at(-1)).toBe("✓ Fetched example/skills · 2.4s\n");
      if (!tty) expect(writes).toHaveLength(1);
    }),
  );
}

it.effect("persists elapsed time on failure without changing the failure", () =>
  Effect.gen(function* () {
    const writes = capture(false);
    const ready = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const fiber = yield* consoleRenderer(false)
      .withStatus(
        {
          pending: "Fetching example/skills",
          complete: "Fetched example/skills",
          persist: "timed",
        },
        Deferred.succeed(ready, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
          Effect.andThen(Effect.fail("unavailable")),
        ),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(ready);
    yield* TestClock.adjust(1200);
    yield* Deferred.succeed(finish, undefined);
    expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toBe("unavailable");
    expect(writes).toEqual(["✖ Fetching example/skills · Incomplete · 1.2s\n"]);
  }),
);

it.effect("suppresses persistent timed progress in JSON mode", () =>
  Effect.gen(function* () {
    const writes = capture(true);
    const value = yield* consoleRenderer(true).withStatus(
      { pending: "Fetching", complete: "Fetched", persist: "timed" },
      Effect.succeed(42),
    );
    expect(value).toBe(42);
    expect(writes).toEqual([]);
  }),
);

it.effect("persists an incomplete timed step when interrupted", () =>
  Effect.gen(function* () {
    const writes = capture(false);
    const ready = yield* Deferred.make<void>();
    const fiber = yield* consoleRenderer(false)
      .withStatus(
        {
          pending: "Fetching example/skills",
          complete: "Fetched example/skills",
          persist: "timed",
        },
        Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(ready);
    yield* TestClock.adjust(1500);
    yield* Fiber.interrupt(fiber);
    expect(writes).toEqual(["✖ Fetching example/skills · Incomplete · 1.5s\n"]);
  }),
);
