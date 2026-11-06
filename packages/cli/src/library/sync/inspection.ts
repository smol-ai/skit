import * as Library from "@smolai/skit-core/library";
import { Effect } from "effect";
import type { SyncProgress, SyncPhase } from "./progress.js";

/** Presentation brackets owner verification; Library alone knows retained paths and archive rules. */
export const inspectSyncSnapshots = Effect.fn("Library.sync.inspectSnapshots")(function* (
  snapshot: Library.Snapshot,
  progress: SyncProgress,
) {
  const library = yield* Library.Service;
  const phase: SyncPhase = {
    kind: "verify-copies",
    total: snapshot._tag === "Present" ? snapshot.state.collection_versions.length : 0,
  };
  return yield* progress.around(
    phase,
    Effect.gen(function* () {
      yield* progress.tick({ phase, completed: 0 });
      const inspected = yield* library.content.inspect(snapshot);
      if (inspected._tag === "Changed") return inspected;
      const archives = yield* library.content.pack(snapshot);
      yield* progress.tick({ phase, completed: phase.total });
      return { _tag: "Verified" as const, archives };
    }),
  );
});
