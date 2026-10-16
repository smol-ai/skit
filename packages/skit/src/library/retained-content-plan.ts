import { Effect, FileSystem } from "effect";
import type { Digest } from "../contracts.js";
import type { LibraryManifest, SnapshotArchive } from "./library-contracts.js";
import { retainedTreePath } from "./retention/retain-tree.js";

/** Captured local archives plus availability observations. Preparation verifies bytes before use. */
export interface RetainedContentPlan {
  readonly localArchives: readonly SnapshotArchive[];
  readonly reusable: readonly Digest[];
  readonly download: readonly Digest[];
  readonly reacquire: readonly LibraryManifest["retained_copies"][number]["retained_copy_id"][];
}

/** Read-only: no hashing, downloads, source acquisition, or writes. */
export const planRetainedContentEffect = Effect.fn("Library.planRetainedContent")(function* (
  manifest: LibraryManifest,
  options: { readonly originalsPath: string; readonly localArchives: readonly SnapshotArchive[] },
) {
  const fs = yield* FileSystem.FileSystem;
  const available = new Set(options.localArchives.map((archive) => archive.digest));
  const seen = new Set<Digest>();
  const snapshots = new Set(manifest.snapshot_digests);
  const reusable: Digest[] = [];
  const download: Digest[] = [];
  const reacquire: LibraryManifest["retained_copies"][number]["retained_copy_id"][] = [];
  for (const copy of manifest.retained_copies) {
    if (seen.has(copy.digest)) continue;
    seen.add(copy.digest);
    if (available.has(copy.digest)) continue;
    if (yield* fs.exists(retainedTreePath(options.originalsPath, copy.digest)))
      reusable.push(copy.digest);
    else if (snapshots.has(copy.digest)) download.push(copy.digest);
    else reacquire.push(copy.retained_copy_id);
  }
  return {
    localArchives: options.localArchives.filter((archive) => seen.has(archive.digest)),
    reusable,
    download,
    reacquire,
  } satisfies RetainedContentPlan;
});
