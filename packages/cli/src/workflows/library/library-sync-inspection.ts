import { captureSnapshotArchive, retainedTreePath, type SnapshotArchive } from "@smolai/skit-core";
import { Effect } from "effect";
import type { SyncObserver, SyncPhase } from "./library-sync-progress.js";

/** Diagnose changed local bytes before reading remote state. Transfer planning lives in core. */
export const inspectSyncSnapshots = Effect.fn("Library.sync.inspectSnapshots")(function* (
  copies: readonly { readonly digest: string }[],
  originalsPath: string,
  observer: SyncObserver,
) {
  const phase: SyncPhase = { kind: "verify-copies", total: copies.length };
  return yield* observer.around(
    phase,
    Effect.gen(function* () {
      const archives = new Map<string, SnapshotArchive>();
      for (const [verified, tree] of copies.entries()) {
        yield* observer.tick({ phase, completed: verified });
        const archive = yield* captureSnapshotArchive(retainedTreePath(originalsPath, tree.digest));
        if (archive.digest !== tree.digest)
          return { _tag: "Changed" as const, digest: tree.digest };
        // Verify every reference, including copies sharing the same digest.
        if (!archives.has(archive.digest)) archives.set(archive.digest, archive);
        yield* observer.tick({ phase, completed: verified + 1 });
      }
      return { _tag: "Verified" as const, archives: [...archives.values()] };
    }),
  );
});
