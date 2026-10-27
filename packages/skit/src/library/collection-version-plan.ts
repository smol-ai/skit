import { Effect, FileSystem } from "effect";
import type { Digest } from "../contracts.js";
import type { LibraryManifest, SnapshotArchive } from "./library-contracts.js";
import { collectionVersionPath } from "./collection-version.js";

/** Captured local archives plus availability observations. Preparation verifies bytes before use. */
export interface CollectionVersionPlan {
  readonly localArchives: readonly SnapshotArchive[];
  readonly reusable: readonly Digest[];
  readonly download: readonly Digest[];
  readonly reacquire: readonly LibraryManifest["retained_copies"][number]["retained_copy_id"][];
}

/** Read-only: no hashing, downloads, source acquisition, or writes. */
export const planCollectionVersions = Effect.fn("Library.planCollectionVersions")(function* (
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
    if (yield* fs.exists(collectionVersionPath(options.originalsPath, copy.digest)))
      reusable.push(copy.digest);
    else if (snapshots.has(copy.digest)) download.push(copy.digest);
    else reacquire.push(copy.retained_copy_id);
  }
  return {
    localArchives: options.localArchives.filter((archive) => seen.has(archive.digest)),
    reusable,
    download,
    reacquire,
  } satisfies CollectionVersionPlan;
});
