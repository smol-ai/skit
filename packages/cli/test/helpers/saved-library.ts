import { Effect } from "effect";
import * as Library from "@smolai/skit-core/library";
import { testRoots } from "./roots.js";

/** Read the authoritative state and revision through a fresh owner after a subprocess exits. */
export const savedLibrary = (home: string) =>
  Effect.gen(function* () {
    const owner = yield* Library.Service;
    const snapshot = yield* owner.read;
    if (snapshot._tag !== "Present") return yield* Effect.die("Expected a saved test Library");
    return snapshot;
  }).pipe(Effect.provide(Library.layer({ home, roots: testRoots(home) })));
