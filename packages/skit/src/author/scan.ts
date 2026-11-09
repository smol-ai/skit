import { Effect } from "effect";
import { walkAuthorTree } from "../artifact/tree.js";
import * as History from "../history/history.js";
import { LocalFilesChangedDuringSync } from "./failures.js";

/** Read one stable Author tree. Recording it and granting removal authority are separate. */
export const scanAuthorWorkspace = Effect.fn("Author.scanWorkspace")(function* (root: string) {
  return yield* Effect.gen(function* () {
    const tree = yield* walkAuthorTree(root, "verbatim");
    const treeHash = yield* History.treeHash(tree);
    const again = yield* History.treeHash(yield* walkAuthorTree(root, "verbatim"));
    if (treeHash !== again) return yield* new LocalFilesChangedDuringSync();
    return { tree, treeHash };
  }).pipe(
    Effect.retry({ times: 2, while: (error) => error._tag === "LocalFilesChangedDuringSync" }),
  );
});
