import { Effect, Layer } from "effect";
import { recover } from "./setup.js";
import { LibraryStore, makeLibraryStore } from "./store/library-store.js";

/**
 * Building the layer migrates a legacy state.json once, then resumes any operation left Pending,
 * each under the home lock, which it takes only when there is something to do. Fails with
 * `LibraryBusy` if the lock is held elsewhere; an operation that stops never fails it. It creates
 * nothing when state.json is absent.
 */
export function libraryStoreLayer(options: { home: string }) {
  return Layer.effect(
    LibraryStore,
    Effect.gen(function* () {
      const store = yield* makeLibraryStore(options);
      const startup = yield* recover().pipe(
        Effect.provideService(LibraryStore, { ...store, startup: { finished: [], stopped: [] } }),
      );
      return { ...store, startup };
    }),
  );
}
