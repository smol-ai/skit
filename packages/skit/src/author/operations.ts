import { Effect, Layer } from "effect";
import { AuthorWorkspace } from "./workspace.js";
import { AuthorHistory } from "./history.js";

export const authorWorkspaceLayer = AuthorWorkspace.layer;
export const authorLayer = (config: { readonly home: string }) =>
  AuthorHistory.layer(config).pipe(Layer.provideMerge(authorWorkspaceLayer));

export const readAuthorWorkspace = Effect.fn("Author.readWorkspace")(function* (input: string) {
  const workspace = yield* AuthorWorkspace;
  return yield* workspace.read(yield* workspace.resolveRoot(input));
});

/** Preserve an observation of the workspace without installing it or changing its connection. */
export const captureAuthorWorkspace = Effect.fn("Author.captureWorkspace")(function* (
  input: string,
) {
  const root = yield* (yield* AuthorWorkspace).resolveRoot(input);
  return yield* (yield* AuthorHistory).capture(root);
});
