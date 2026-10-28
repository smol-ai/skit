import { Effect, FileSystem } from "effect";
import type { Hash } from "../contracts.js";
import type { LibraryManifest, SnapshotArchive } from "./library-contracts.js";
import { collectionVersionPath } from "./collection-version.js";

/** Captured local archives plus availability observations. Preparation verifies bytes before use. */
export interface CollectionVersionPlan {
  readonly localArchives: readonly SnapshotArchive[];
  readonly reusable: readonly Hash[];
  readonly download: readonly Hash[];
  readonly reacquire: readonly LibraryManifest["collection_versions"][number]["collection_version_id"][];
}

/** Read-only: no hashing, downloads, source acquisition, or writes. */
export const planCollectionVersions = Effect.fn("Library.planCollectionVersions")(function* (
  manifest: LibraryManifest,
  options: { readonly originalsPath: string; readonly localArchives: readonly SnapshotArchive[] },
) {
  const fs = yield* FileSystem.FileSystem;
  const available = new Set(options.localArchives.map((archive) => archive.digest));
  const seen = new Set<Hash>();
  const snapshots = new Set(manifest.snapshot_digests);
  const reusable: Hash[] = [];
  const download: Hash[] = [];
  const reacquire: LibraryManifest["collection_versions"][number]["collection_version_id"][] = [];
  for (const copy of manifest.collection_versions) {
    if (seen.has(copy.hash)) continue;
    seen.add(copy.hash);
    if (available.has(copy.hash)) continue;
    if (yield* fs.exists(collectionVersionPath(options.originalsPath, copy.hash)))
      reusable.push(copy.hash);
    else if (snapshots.has(copy.hash)) download.push(copy.hash);
    else reacquire.push(copy.collection_version_id);
  }
  return {
    localArchives: options.localArchives.filter((archive) => seen.has(archive.digest)),
    reusable,
    download,
    reacquire,
  } satisfies CollectionVersionPlan;
});
