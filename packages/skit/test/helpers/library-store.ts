import { Context, Effect, Layer } from "effect";
import * as Library from "../../src/library/library.js";
import {
  inspectLocalLibraryState,
  LibraryWriter,
  loadLibrary,
  writeLibrary,
} from "../../src/library/store/library-store.js";
import type { LibraryState } from "../../src/library/library-state.js";

/** Run an Effect that saves, inside one write to the Library rooted at `home`. */
export const inLibrary =
  (home: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | LibraryWriter>) =>
    writeLibrary(home, effect);

export const inspectLibrary = (home: string) => inspectLocalLibraryState(home);

export const saveLibrary = (home: string, state: LibraryState) =>
  writeLibrary(
    home,
    Effect.gen(function* () {
      yield* (yield* LibraryWriter).save(state, yield* loadLibrary(home));
    }),
  );

/** The Library rooted at `home`, routing nothing; building it migrates a legacy state.json. */
export const libraryLayer = (home: string) => Library.layer({ home, routing: { _tag: "None" } });

/** Build the public owner in the caller's test scope, with no installed-skill destinations. */
export const openLibrary = (home: string) =>
  Effect.map(Layer.build(libraryLayer(home)), (context) => Context.get(context, Library.Service));
