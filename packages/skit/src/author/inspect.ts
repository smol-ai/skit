import { Effect, FileSystem } from "effect";
import { resolve } from "node:path";
import { authorIgnoreRepositoryLayer } from "../artifact/plain-author-ignore.js";
import { checkAuthorRemovals } from "./history.js";
import { scanAuthorWorkspace } from "./scan.js";

/** Inspect stable inputs and removal authority without registering, saving history or syncing. */
export const inspectAuthorWorkspace = Effect.fn("Author.inspectWorkspace")(function* (
  input: string,
  home: string,
  workspaceId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(resolve(input));
  const { tree } = yield* scanAuthorWorkspace(root).pipe(
    Effect.provide(authorIgnoreRepositoryLayer),
  );
  const removal = yield* checkAuthorRemovals(home, workspaceId, tree);
  return { tree, removal };
});
