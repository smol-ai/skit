import { Effect } from "effect";
import * as Library from "@smolai/skit-core/library";
import { assertDiskUnchanged, captureDisk } from "./disk-snapshot.js";
import { testRoots } from "./roots.js";

/** Query the public view; recovery or history delivery must never repair this test's evidence. */
export const readLibraryManifest = Effect.fn("Test.readLibraryManifest")(function* (
  home: string,
  roots: readonly string[],
) {
  const before = yield* captureDisk(roots, { identity: true });
  const manifest = yield* Effect.flatMap(Library.Service, (library) => library.manifest).pipe(
    Effect.provide(Library.layer({ home, roots: testRoots(home) })),
  );
  yield* assertDiskUnchanged(before);
  return manifest;
});
