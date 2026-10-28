import {
  readSnapshotArchive,
  collectionVersionPath,
  type SnapshotArchive,
} from "@smolai/skit-core";
import { Effect } from "effect";
import type { SyncProgress, SyncPhase } from "./library-sync-progress.js";

/** Diagnose changed local bytes before reading remote state. Transfer planning lives in core. */
export const inspectSyncSnapshots = Effect.fn("Library.sync.inspectSnapshots")(function* (
  copies: readonly { readonly hash: string }[],
  originalsPath: string,
  progress: SyncProgress,
) {
  const phase: SyncPhase = { kind: "verify-copies", total: copies.length };
  return yield* progress.around(
    phase,
    Effect.gen(function* () {
      const archives = new Map<string, SnapshotArchive>();
      for (const [verified, tree] of copies.entries()) {
        yield* progress.tick({ phase, completed: verified });
        const archive = yield* readSnapshotArchive(collectionVersionPath(originalsPath, tree.hash));
        if (archive.digest !== tree.hash) return { _tag: "Changed" as const, hash: tree.hash };
        // Verify every reference, including copies sharing the same digest.
        if (!archives.has(archive.digest)) archives.set(archive.digest, archive);
        yield* progress.tick({ phase, completed: verified + 1 });
      }
      return { _tag: "Verified" as const, archives: [...archives.values()] };
    }),
  );
});
