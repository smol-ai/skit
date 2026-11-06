import { Effect, Stream } from "effect";
import {
  AuthorHistory,
  AuthorHistoryInvalid,
  type Observation,
  type SyncKey,
  type WorkspaceLease,
} from "@smolai/skit-core/author";
import * as History from "@smolai/skit-core/history";
import type * as Sync from "@smolai/skit-core/sync";

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
