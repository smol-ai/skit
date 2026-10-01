// Runtime entry and disposal are the subject here, so these tests drive the Promise host API.
import { Deferred, Effect, Layer } from "effect";
import { expect, test } from "vitest";
import type { LibrarySessionState, LibrarySkillRow } from "../../cli/src/front-end";
import { createLibraryHost } from "../src/library-host";

/**
 * Await a Deferred from outside the host's runtime.
 *
 * These tests observe the host across its own boundary -- including after `dispose()`, when
 * `host.run` rejects by design -- so they need a root runtime of their own to settle the
 * Deferreds the host's fibers complete. That is the subject under test, not debt.
 */
// oxlint-disable-next-line skit/no-nested-runtime
const outside = <A>(effect: Effect.Effect<A>): Promise<A> => Effect.runPromise(effect);

const initial: LibrarySessionState = { skills: [] };
const row = (name: string) => ({ name }) as LibrarySkillRow;
const names = (state: LibrarySessionState | undefined) => state?.skills.map((skill) => skill.name);

test("queued transitions read the state committed by their predecessor", async () => {
  const reached = Deferred.makeUnsafe<void>();
  const resume = Deferred.makeUnsafe<void>();
  const host = createLibraryHost(Layer.empty, Effect.succeed(initial));
  try {
    await host.open();
    const first = host.transition((state) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(reached, undefined);
        yield* Deferred.await(resume);
        return { ...state, skills: [row("first")] };
      }),
    );
    await outside(Deferred.await(reached));
    const seen: LibrarySessionState[] = [];
    const second = host.transition((state) =>
      Effect.sync(() => {
        seen.push(state);
        return { ...state, skills: [...state.skills, row("second")] };
      }),
    );
    await outside(Deferred.succeed(resume, undefined));
    await Promise.all([first, second]);
    expect(seen.map(names)).toEqual([["first"]]);
    expect(names(host.state)).toEqual(["first", "second"]);
    expect(initial.skills).toEqual([]);
  } finally {
    await host.dispose();
  }
});

test("disposal waits for in-flight finalization before releasing host resources", async () => {
  const reached = Deferred.makeUnsafe<void>();
  const cleanupStarted = Deferred.makeUnsafe<void>();
  const cleanupResume = Deferred.makeUnsafe<void>();
  const events: string[] = [];
  const resources = Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.sync(() => {
        events.push("acquired");
      }),
      () =>
        Effect.sync(() => {
          events.push("released");
        }),
    ),
  );
  const host = createLibraryHost(resources, Effect.succeed(initial));
  await host.open();
  const operation = host.transition(() =>
    Effect.gen(function* () {
      yield* Deferred.succeed(reached, undefined);
      return yield* Effect.never;
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Deferred.succeed(cleanupStarted, undefined);
          yield* Deferred.await(cleanupResume);
          events.push("finalized");
        }),
      ),
    ),
  );
  const failed = operation.then(
    () => false,
    () => true,
  );
  await outside(Deferred.await(reached));
  let queuedRan = false;
  const queued = host
    .transition((state) =>
      Effect.sync(() => {
        queuedRan = true;
        return state;
      }),
    )
    .then(
      () => false,
      () => true,
    );
  const disposing = host.dispose();
  try {
    await outside(Deferred.await(cleanupStarted));
    expect(events).toEqual(["acquired"]);
  } finally {
    await outside(Deferred.succeed(cleanupResume, undefined));
    await disposing;
  }
  expect(await failed).toBe(true);
  expect(await queued).toBe(true);
  expect(queuedRan).toBe(false);
  await expect(host.transition((state) => Effect.succeed(state))).rejects.toThrow("disposed");
  await host.dispose();
  expect(events).toEqual(["acquired", "finalized", "released"]);
  expect(host.state).toBe(initial);
});
