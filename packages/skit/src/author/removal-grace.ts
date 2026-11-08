import { Clock, Effect } from "effect";
import type * as Sync from "../sync/sync.js";

/** One foreground watch's removal observations. Restart or unreadability forgets the grace. */
export const makeRemovalGrace = () => {
  let pending: { readonly key: string; readonly since: bigint } | undefined;
  return {
    reset: Effect.sync(() => {
      pending = undefined;
    }),
    check: (input: Sync.PlanInput) =>
      Effect.gen(function* () {
        // Recovery replays a previously prepared operation, rather than approving another removal.
        if (input._tag !== "Idle" || input.base === null) return undefined;
        const kept = new Set(input.local.tree.map((entry) => entry.path));
        const known = input.base.tree.filter((entry) => entry.kind !== "directory");
        const paths = known
          .filter((entry) => !kept.has(entry.path))
          .map((entry) => entry.path)
          .sort();
        if (paths.length === 0) {
          pending = undefined;
          return undefined;
        }
        const removal = { deleting: paths.length, of: known.length, paths };
        // Bulk removal never ages into permission. The existing sync planner reports it blocked.
        if (
          paths.length === known.length ||
          (paths.length > 5 && paths.length > known.length / 2)
        ) {
          pending = undefined;
          return undefined;
        }
        const key = JSON.stringify({ base: input.base.id, paths });
        const now = yield* Clock.currentTimeNanos;
        if (pending?.key !== key) {
          pending = { key, since: now };
          return removal;
        }
        return now - pending.since >= 10_000_000_000n ? undefined : removal;
      }),
  };
};

export type RemovalGrace = ReturnType<typeof makeRemovalGrace>;
