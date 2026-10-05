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
