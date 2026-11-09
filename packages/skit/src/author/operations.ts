import { Effect, Layer } from "effect";
import { AuthorWorkspace } from "./workspace.js";
import { AuthorHistory, authorHistoryStoreError } from "./history.js";
import * as Library from "../library/library.js";

export const authorWorkspaceLayer = AuthorWorkspace.layer;
export const authorLayer = (config: { readonly home: string }) =>
  AuthorHistory.layer(config).pipe(Layer.provideMerge(authorWorkspaceLayer));

export const readAuthorWorkspace = Effect.fn("Author.readWorkspace")(function* (input: string) {
  const workspace = yield* AuthorWorkspace;
  return yield* workspace.read(yield* workspace.resolveRoot(input));
});

/** Preserve an observation of the workspace without installing it or changing its connection. */
export const refreshAuthorWorkspace = Effect.fn("Author.refreshWorkspace")(function* (
  input: string,
) {
  const root = yield* (yield* AuthorWorkspace).resolveRoot(input);
  return yield* (yield* AuthorHistory).refresh(root);
});

/** One workspace lease orders saved inputs and installation against manual sync/edits. */
export const updateAuthoredSkills = Effect.fn("Author.updateSkills")(function* (input: string) {
  const workspaces = yield* AuthorWorkspace;
  const root = yield* workspaces.resolveRoot(input);
  yield* workspaces.acquire(root);
  const identity = yield* workspaces.readIdentity(root);
  if (identity._tag === "None")
    return { status: "unregistered" as const, installed: 0, messages: [] as string[] };
  const history = yield* AuthorHistory;
  const saved = yield* history.refresh(root);
  const tree = yield* history.engineStore
    .tree(saved.treeHash)
    .pipe(Effect.mapError(authorHistoryStoreError));
  const library = yield* Library.Service;
  return yield* library.refreshAuthored({
    workspaceId: identity.value.workspaceId,
    input: root,
    tree,
    revisionId: saved.id,
    savedAt: new Date(saved.revision.author.at).toISOString(),
  });
}, Effect.scoped);
