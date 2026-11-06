import { Effect, Layer } from "effect";
import { AuthorHistory } from "../../src/author/history.js";
import { authorLayer as owners, captureAuthorWorkspace } from "../../src/author/index.js";
export const authorLayer = (home: string) => Layer.fresh(owners({ home }));
export const captureWorkspace = captureAuthorWorkspace;
const storedTrees = Effect.gen(function* () {
  const store = (yield* AuthorHistory).engineStore;
  return yield* Effect.forEach(yield* store.trees, (hash) =>
    Effect.map(store.tree(hash), (tree) => ({ hash, tree })),
  );
});
export const storedTreesAt = (home: string) => storedTrees.pipe(Effect.provide(authorLayer(home)));
