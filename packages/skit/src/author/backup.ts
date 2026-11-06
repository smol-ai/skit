import { AuthorWorkspace } from "./workspace.js";
import { skitLocator } from "./destination.js";
import { Effect, Stream, Option, Schema } from "effect";
import { type SyncKey } from "./workspace.js";
import { AuthorHistoryInvalid, type Observation } from "./history.js";
import { AuthorHistory, authorHistoryStoreError } from "./history.js";
import type { WorkspaceLease } from "./workspace.js";
import * as History from "../history/history.js";
import type * as Sync from "../sync/sync.js";

/** Back up chronological observations without making an old edit current again. */
export const backupAuthorHistory = Effect.fn("Author.backupHistory")(function* (
  lease: WorkspaceLease,
  key: SyncKey,
  observation: Observation,
  remote: Pick<Sync.Remote, "post">,
) {
  const history = yield* AuthorHistory;
  let acknowledged = yield* history.backupState.read(key);
  if (acknowledged === observation.id) return;
  // capture's observations form one chronological parent chain. Verify those revisions before any
  // remote write; an unavailable ancestor cannot be silently replaced by a new backup root.
  const chain = yield* History.ancestors(history.engineStore, observation.id).pipe(
    Stream.takeUntil(({ id }) => id === acknowledged),
    Stream.runCollect,
  );
  if (acknowledged !== null && chain.at(-1)?.id !== acknowledged)
    return yield* new AuthorHistoryInvalid({
      path: "history",
      reason: "the acknowledged backup is not an ancestor of this workspace's observation",
    });
  for (const { id, revision } of chain.toReversed()) {
    if (id === acknowledged) continue;
    const tree = yield* history.engineStore.tree(revision.tree);
    // POST is content-addressed and idempotent, so losing this response or the following save
    // safely repeats the same revision. It never moves the Registry's current pointer.
    yield* remote.post(id, revision, tree);
    yield* history.backupState.save(lease, key, { from: acknowledged, to: id });
    acknowledged = id;
  }
});

/** Upload observations to the connected Registry without moving its current revision. */
export const backupAuthorWorkspace = Effect.fn("Author.backupWorkspace")(function* (
  input: string,
  remote: Pick<Sync.Remote, "post">,
) {
  const workspaces = yield* AuthorWorkspace;
  const root = yield* workspaces.resolveRoot(input);
  const lease = yield* workspaces.acquire(root);
  const workspace = yield* workspaces.read(root);
  if (Option.isNone(workspace.identity) || workspace.connection._tag !== "Connected")
    return yield* new AuthorHistoryInvalid({
      path: input,
      reason: "backup requires a connected workspace",
    });
  yield* backupAuthorHistory(
    lease,
    {
      workspaceId: workspace.identity.value.workspaceId,
      locator: skitLocator(workspace.connection.remote),
    },
    yield* (yield* AuthorHistory).capture(root),
    remote,
  ).pipe(
    Effect.catchIf(Schema.is(History.StoreError), (error) =>
      Effect.fail(authorHistoryStoreError(error)),
    ),
  );
}, Effect.scoped);
