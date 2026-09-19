import { Effect } from "effect";
import { LibraryStore, libraryStoreLayer } from "../../src/library/store/library-store.js";
import type { LibraryState } from "../../src/library/library-state.js";

/** Run an Effect against the Library rooted at `home`, through the store production consumes. */
export const inLibrary =
  (home: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(libraryStoreLayer({ home })));

export const inspectLibrary = (home: string) =>
  Effect.flatMap(LibraryStore, (store) => store.inspect).pipe(inLibrary(home));

export const publishLibrary = (home: string, state: LibraryState) =>
  Effect.flatMap(LibraryStore, (store) => store.publish(state)).pipe(inLibrary(home));
