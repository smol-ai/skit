import {
  captureSnapshotArchiveEffect,
  prepareRestoreEffect,
  retainedTreePath,
  type LibraryManifest,
  type SnapshotArchive,
} from "@smolai/skit-core";
import { Effect } from "effect";
import type { librarySyncApiEffect } from "./library-sync-api.js";

type SnapshotApi = Pick<
  Effect.Success<ReturnType<typeof librarySyncApiEffect>>,
  "download" | "upload"
>;
type RemoteSnapshots = { readonly library_id: string; readonly manifest: LibraryManifest } | null;

/** Verify local copies before reading the remote; keep archives private to the transfer plan. */
export const inspectSyncSnapshots = Effect.fn("Library.sync.inspectSnapshots")(function* (
  copies: readonly { readonly digest: string }[],
  originalsPath: string,
  progress: (message: string) => Effect.Effect<void>,
) {
  const archives = new Map<string, SnapshotArchive>();
  for (const [verified, tree] of copies.entries()) {
    yield* progress(`Verifying retained copies · ${verified}/${copies.length}`);
    const archive = yield* captureSnapshotArchiveEffect(
      retainedTreePath(originalsPath, tree.digest),
    );
    if (archive.digest !== tree.digest) return { _tag: "Changed" as const, digest: tree.digest };
    // Verify every reference, including copies sharing the same digest.
    if (!archives.has(archive.digest)) archives.set(archive.digest, archive);
  }
  return {
    _tag: "Verified" as const,
    prepareTransfer: (
      desired: LibraryManifest,
      remote: RemoteSnapshots,
      api: SnapshotApi,
      registry: { readonly origin: string; readonly token?: string },
    ) => {
      const required = new Set(desired.retained_copies.map((tree) => tree.digest));
      const snapshotSet = new Set(desired.snapshot_digests);
      const downloads = [...required].filter(
        (digest) => !archives.has(digest) && snapshotSet.has(digest),
      );
      const uploads = [...archives.values()].filter(
        (archive) =>
          required.has(archive.digest) &&
          snapshotSet.has(archive.digest) &&
          !remote?.manifest.snapshot_digests.includes(archive.digest),
      );
      return {
        snapshotCount: remote === null ? uploads.length : downloads.length,
        restore: Effect.fn("Library.sync.restoreSnapshots")(function* () {
          let completed = 0;
          if (downloads.length) yield* progress(`Downloading Skill copies · 0/${downloads.length}`);
          const downloaded =
            remote === null
              ? []
              : yield* Effect.forEach(
                  downloads,
                  (digest) =>
                    api
                      .download(remote.library_id, digest)
                      .pipe(
                        Effect.tap(() =>
                          progress(`Downloading Skill copies · ${++completed}/${downloads.length}`),
                        ),
                      ),
                  // Retention starts only after every download succeeds.
                  { concurrency: 4 },
                );
          yield* progress("Restoring retained Skill copies");
          return yield* Effect.scoped(
            prepareRestoreEffect(desired, [...archives.values(), ...downloaded], {
              originalsPath,
              onProgress: progress,
              registryBaseUrl: registry.origin,
              ...(registry.token === undefined ? {} : { registryToken: registry.token }),
            }),
          );
        }),
        upload: Effect.fn("Library.sync.uploadSnapshots")(function* () {
          for (const [index, archive] of uploads.entries()) {
            yield* progress(`Uploading Skill copies · ${index}/${uploads.length}`);
            yield* api.upload(archive);
            yield* progress(`Uploading Skill copies · ${index + 1}/${uploads.length}`);
          }
        }),
      };
    },
  };
});
