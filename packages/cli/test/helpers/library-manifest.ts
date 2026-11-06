import { Effect } from "effect";
import * as Library from "@smolai/skit-core/library";
import { readLibraryManifest as readManifest } from "@smolai/skit-core/library/queries";
import { assertDiskUnchanged, captureDisk } from "./disk-snapshot.js";

/** Query the public view; recovery or history delivery must never repair this test's evidence. */
export const readLibraryManifest = Effect.fn("Test.readLibraryManifest")(function* (
  home: string,
  roots: readonly string[],
) {
  const before = yield* captureDisk(roots, { identity: true });
  const manifest = yield* readManifest(home).pipe(
    Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
  );
  yield* assertDiskUnchanged(before);
  return manifest;
});
