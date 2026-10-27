import {
  planRetainedContent,
  prepareRestore,
  type LibraryManifest,
  type SnapshotArchive,
  type RestoreProgress,
} from "@smolai/skit-core";
import { Effect } from "effect";
import type { librarySyncApi } from "./library-sync-api.js";
import { silentSyncProgress, type SyncProgress } from "./library-sync-progress.js";

type SnapshotApi = Pick<Effect.Success<ReturnType<typeof librarySyncApi>>, "download" | "upload">;
type RemoteSnapshots = { readonly library_id: string; readonly manifest: LibraryManifest } | null;

/** Sync owns upload selection and transport; core owns content availability and restoration. */
export const prepareSyncTransfer = Effect.fn("Library.sync.prepareTransfer")(function* (
  archives: readonly SnapshotArchive[],
  desired: LibraryManifest,
  remote: RemoteSnapshots,
  api: SnapshotApi,
  options: {
    readonly originalsPath: string;
    readonly origin: string;
    readonly token?: string;
    readonly progress?: SyncProgress;
    readonly restoreProgress?: RestoreProgress;
  },
) {
  const progress = options.progress ?? silentSyncProgress;
  const content = yield* planRetainedContent(desired, {
    originalsPath: options.originalsPath,
    localArchives: archives,
  });
  const required = new Set(desired.retained_copies.map((tree) => tree.digest));
  const snapshotSet = new Set(desired.snapshot_digests);
  const uploads = archives.filter(
    (archive) =>
      required.has(archive.digest) &&
      snapshotSet.has(archive.digest) &&
      !remote?.manifest.snapshot_digests.includes(archive.digest),
  );
  return {
    snapshotCount: remote === null ? uploads.length : content.download.length,
    restore: Effect.fn("Library.sync.restoreSnapshots")(function* () {
      return yield* Effect.scoped(
        prepareRestore(desired, content, {
          originalsPath: options.originalsPath,
          ...(options.restoreProgress === undefined ? {} : { progress: options.restoreProgress }),
          ...(remote === null
            ? {}
            : {
                download: (digest: SnapshotArchive["digest"]) =>
                  api.download(remote.library_id, digest),
              }),
          registryBaseUrl: options.origin,
          ...(options.token === undefined ? {} : { registryToken: options.token }),
        }),
      );
    }),
    upload: Effect.fn("Library.sync.uploadSnapshots")(function* () {
      if (uploads.length === 0) return;
      const phase = { kind: "upload", total: uploads.length } as const;
      yield* progress.around(
        phase,
        Effect.gen(function* () {
          for (const [index, archive] of uploads.entries()) {
            yield* progress.tick({ phase, completed: index });
            yield* api.upload(archive);
            yield* progress.tick({ phase, completed: index + 1 });
          }
        }),
      );
    }),
  };
});
