import { Effect, Layer, ManagedRuntime, Semaphore } from "effect";
import type { LibrarySessionState } from "../../cli/src/front-end";

/** Executable host boundary: one runtime, ordered transitions, and explicit disposal. */
export function createLibraryHost<R, E, OpenError>(
  layer: Layer.Layer<R, E>,
  initial: Effect.Effect<LibrarySessionState, OpenError, NoInfer<R>>,
) {
  const runtime = ManagedRuntime.make(layer);
  const transitions = Semaphore.makeUnsafe(1);
  let state: LibrarySessionState | undefined;
  const active = new Map<AbortController, Promise<unknown>>();
  let closing = false;
  let disposal: Promise<void> | undefined;
  const run = <A, Error>(effect: Effect.Effect<A, Error, R>): Promise<A> => {
    if (closing) return Promise.reject(new Error("Library host is disposed"));
    const controller = new AbortController();
    const operation = runtime.runPromise(effect, { signal: controller.signal });
    active.set(controller, operation);
    const finished = () => {
      active.delete(controller);
    };
    void operation.then(finished, finished);
    return operation;
  };
  return {
    /** Run one workflow on the host runtime; it is aborted with the host on disposal. */
    run,
    get state() {
      return state;
    },
    async open() {
      state = await run(initial);
      return state;
    },
    transition<Error>(
      update: (state: LibrarySessionState) => Effect.Effect<LibrarySessionState, Error, R>,
    ) {
      return run(
        transitions.withPermit(
          Effect.gen(function* () {
            if (!state) return yield* Effect.die("Library session is unavailable");
            const next = yield* update(state);
            state = next;
            return next.outcome;
          }),
        ),
      );
    },
    dispose() {
      if (!disposal) {
        closing = true;
        const pending = [...active.values()];
        for (const controller of active.keys()) controller.abort();
        disposal = Promise.allSettled(pending).then(() => runtime.dispose());
      }
      return disposal;
    },
  };
}
