import { Library } from "@smolai/skit-core/library";
import {
  type LibraryManifest,
  type SnapshotArchive,
  type RestoreProgress,
  RestoreInvalid,
} from "@smolai/skit-core/library";
import { Effect, Option } from "effect";
import type { librarySyncApi } from "./api.js";
import { silentSyncProgress, type SyncProgress } from "./progress.js";

type SnapshotApi = Pick<Effect.Success<ReturnType<typeof librarySyncApi>>, "download" | "upload">;
type RemoteSnapshots = { readonly library_id: string; readonly manifest: LibraryManifest } | null;

/** Sync owns upload selection and transport; core owns content availability and restoration. */
export const prepareSyncTransfer = Effect.fn("Library.sync.prepareTransfer")(function* (
  archives: readonly SnapshotArchive[],
  desired: LibraryManifest,
  remote: RemoteSnapshots,
  api: SnapshotApi,
  options: {
    readonly origin: string;
    readonly token?: string;
    readonly progress?: SyncProgress;
    readonly restoreProgress?: RestoreProgress;
  },
) {
  const progress = options.progress ?? silentSyncProgress;
  const library = yield* Library.Service;
  const content = yield* library.content.plan(desired, archives);
  const required = new Set(desired.collection_versions.map((tree) => tree.hash));
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
      const staged = yield* library.content.stage(desired, {
        plan: content,
        registry: { origin: options.origin, token: Option.fromNullishOr(options.token) },
        ...(options.restoreProgress === undefined ? {} : { progress: options.restoreProgress }),
        ...(remote === null
          ? {}
          : {
              download: (hash: SnapshotArchive["digest"]) => api.download(remote.library_id, hash),
            }),
      });
      if (staged.missing.length)
        return yield* new RestoreInvalid({
          detail: `retained copies unavailable: ${staged.missing.join(", ")}`,
        });
      return staged;
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
