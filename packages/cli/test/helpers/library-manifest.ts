import { Effect } from "effect";
import { Library } from "@smolai/skit-core/library";
import { openLibraryView } from "@smolai/skit-core/library/session";
import { assertDiskUnchanged, captureDisk } from "./disk-snapshot.js";

/** Query the public view; recovery or history delivery must never repair this test's evidence. */
export const readLibraryManifest = Effect.fn("Test.readLibraryManifest")(function* (home: string) {
  const before = yield* captureDisk([home], { identity: true });
  const manifest = yield* Effect.flatMap(openLibraryView(home), (view) => view.readManifest()).pipe(
    Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
  );
  yield* assertDiskUnchanged(before);
  return manifest;
});
