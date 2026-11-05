import { Effect, Layer } from "effect";
import type { History } from "@smolai/skit-core";
import { AuthorHistory, AuthorWorkspace } from "@smolai/skit-core/author";

/**
 * AuthorHistory over `home` with AuthorWorkspace from the same graph, as the CLI builds them.
 * Fresh, so both owners use the services (a test's FileSystem, say) in scope where it is provided.
 * Each provide is its own runtime with its own journal permit: concurrent captures meant to share
 * one permit must run under one provide.
 */
export const authorLayer = (home: string) =>
  Layer.fresh(AuthorHistory.layer({ home }).pipe(Layer.provideMerge(AuthorWorkspace.layer)));

/** Capture the workspace at `input` through the owners, as sync does. */
export const captureWorkspace = Effect.fn("Test.captureWorkspace")(function* (input: string) {
  const root = yield* (yield* AuthorWorkspace).resolveRoot(input);
  return yield* (yield* AuthorHistory).capture(root);
});

/** Every tree the history store holds, each read back and verified. */
export const storedTrees = Effect.gen(function* () {
  const store = (yield* AuthorHistory).engineStore;
  return yield* Effect.forEach(yield* store.trees, (hash) =>
    Effect.map(store.tree(hash), (tree) => ({ hash, tree })),
  );
});

/** Every tree `home`'s history holds; a store that cannot read back fails the test. */
export const storedTreesAt = (home: string) =>
  storedTrees.pipe(Effect.provide(authorLayer(home)), Effect.orDie);

/** The tree a capture recorded, read back from the history store. */
export const capturedTree = Effect.fn("Test.capturedTree")(function* (observation: {
  readonly treeHash: History.TreeHash;
}) {
  return yield* (yield* AuthorHistory).engineStore.tree(observation.treeHash);
});
