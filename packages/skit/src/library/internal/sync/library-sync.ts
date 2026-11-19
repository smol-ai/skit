import { Effect, Option } from "effect";
import type * as Library from "../../library.js";
import { RestoreInvalid } from "../content/restore.js";
import { LibraryManifest, type SnapshotArchive } from "../../library-contracts.js";
import type { RestoreProgress } from "../../restore-progress.js";
import type { InventoryRootOptions } from "../../routing/roots.js";
import type { SyncChanges } from "../../sync-changes.js";
import type { SyncIssue } from "../../sync-issues.js";
import { openSyncSession, type SyncSessionRequest } from "./session.js";
import { silentSyncProgress, type SyncPhase, type SyncProgress } from "./progress.js";
import { canonicalJson } from "../../../shared/json.js";
import { StalePlan } from "../../plan-failures.js";
import type { SyncAcceptance, saveSyncAncestry } from "../../store/sync-ancestry.js";
import { normalizeLibraryManifest } from "../../manifest.js";

export type RemoteLibrary = NonNullable<SyncSessionRequest["remote"]>;

/** Registry protocol only: the owner decides what to read, upload, write and download. */
export interface LibrarySyncTransport<ReadError, UploadError, WriteError, DownloadError, R> {
  readonly read: Effect.Effect<RemoteLibrary | null, ReadError, R>;
  readonly upload: (archive: SnapshotArchive) => Effect.Effect<unknown, UploadError, R>;
  readonly write: (
    expectedRevisionId: string | null,
    manifest: LibraryManifest,
  ) => Effect.Effect<RemoteLibrary, WriteError, R>;
  readonly download: (
    libraryId: string,
    hash: SnapshotArchive["digest"],
  ) => Effect.Effect<SnapshotArchive, DownloadError, R>;
}

/** Presentation brackets owner verification; Library alone knows retained paths and archive rules. */
const inspectSyncSnapshots = Effect.fn("Library.sync.inspectSnapshots")(function* (
  library: Pick<Library.Interface, "content">,
  snapshot: Library.Snapshot,
  progress: SyncProgress,
) {
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

/** Sync owns upload selection; the transport moves bytes; content availability stays local. */
const prepareSyncTransfer = Effect.fn("Library.sync.prepareTransfer")(function* <
  UploadError,
  DownloadError,
  R,
>(
  library: Pick<Library.Interface, "content">,
  archives: readonly SnapshotArchive[],
  desired: LibraryManifest,
  remote: RemoteLibrary | null,
  transport: Pick<
    LibrarySyncTransport<never, UploadError, never, DownloadError, R>,
    "download" | "upload"
  >,
  options: {
    readonly origin: string;
    readonly token?: string;
    readonly progress: SyncProgress;
    readonly restoreProgress?: RestoreProgress;
  },
) {
  const progress = options.progress;
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
        registry: {
          origin: options.origin,
          token: Option.fromNullishOr(options.token),
        },
        ...(options.restoreProgress === undefined ? {} : { progress: options.restoreProgress }),
        ...(remote === null
          ? {}
          : {
              download: (hash: SnapshotArchive["digest"]) =>
                transport.download(remote.library_id, hash),
            }),
      });
      if (staged.missing.length)
        return yield* new RestoreInvalid({
          reason: { _tag: "CopiesUnavailable", ids: staged.missing },
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
            yield* transport.upload(archive);
            yield* progress.tick({ phase, completed: index + 1 });
          }
        }),
      );
    }),
  };
});

/**
 * One Library sync over the given transport; every local decision and effect stays here. The
 * Library uses the roots it was constructed with.
 */
export const syncLibrary = Effect.fn("Library.sync")(function* <
  ReadError,
  UploadError,
  WriteError,
  DownloadError,
  R,
>(
  library: Pick<Library.Interface, "read" | "plan" | "apply" | "content">,
  roots: InventoryRootOptions,
  options: {
    readonly origin: string;
    readonly token?: string;
    readonly apply: boolean;
    readonly takeRemote?: readonly string[];
    readonly keepEnabled?: readonly string[];
    readonly deviceSelection?:
      | "follow-account"
      | {
          readonly skills: readonly string[];
          readonly collections: readonly string[];
        };
    readonly onPlan?: (plan: SyncChanges) => Effect.Effect<void>;
    readonly progress?: SyncProgress;
    readonly restoreProgress?: RestoreProgress;
  },
  transport: LibrarySyncTransport<ReadError, UploadError, WriteError, DownloadError, R>,
  accept: (
    request: SyncAcceptance,
  ) => Effect.Effect<void, Effect.Error<ReturnType<typeof saveSyncAncestry>>>,
) {
  const progress = options.progress ?? silentSyncProgress;
  let installed = 0;
  let uninstalled = 0;
  for (let attempt = 0; ; attempt++) {
    const snapshot = yield* progress.around({ kind: "inspect-local" }, library.read);
    const inventory = yield* inspectSyncSnapshots(library, snapshot, progress);
    if (inventory._tag === "Changed")
      return { status: "local_bytes_changed" as const, hash: inventory.hash };
    const remote = yield* progress.around({ kind: "read-remote" }, transport.read);
    const session = yield* openSyncSession(
      library,
      roots,
      {
        origin: options.origin,
        remote,
        ...(options.takeRemote === undefined ? {} : { takeRemote: options.takeRemote }),
        ...(options.keepEnabled === undefined ? {} : { keepEnabled: options.keepEnabled }),
        ...(options.deviceSelection === undefined
          ? {}
          : { deviceSelection: options.deviceSelection }),
        around: (phase, work) => progress.around(phase, work),
      },
      { base: snapshot },
    );
    if (session._tag === "Empty") {
      if (options.apply) yield* session.apply;
      return { status: "clean" as const, changed: false };
    }
    if (session._tag === "Stopped") return session.result;
    const { target, plan, note } = session;
    if (session.direction === "clean" && remote !== null) {
      const copies = options.apply
        ? yield* Effect.gen(function* () {
            const staged = yield* library.content.stage(target, {
              localArchives: inventory.archives,
              registry: {
                origin: options.origin,
                token: Option.fromUndefinedOr(options.token),
              },
            });
            const prepared = yield* session.prepare(staged);
            return yield* progress.around({ kind: "save-local" }, prepared.apply(remote));
          })
        : {
            installed: 0,
            uninstalled: 0,
            enablementIssues: [] as readonly SyncIssue[],
          };
      return {
        ...note,
        status: copies.enablementIssues.length
          ? ("enablement_incomplete" as const)
          : ("clean" as const),
        ...(copies.enablementIssues.length
          ? {
              sync_status: "clean" as const,
              enablement_issues: copies.enablementIssues,
            }
          : {}),
        changed: false,
        revision_id: remote.revision_id,
        installed: installed + copies.installed,
        uninstalled: uninstalled + copies.uninstalled,
      };
    }
    const transfer = yield* prepareSyncTransfer(
      library,
      inventory.archives,
      target,
      remote,
      transport,
      {
        origin: options.origin,
        ...(options.token === undefined ? {} : { token: options.token }),
        progress,
        ...(options.restoreProgress === undefined
          ? {}
          : { restoreProgress: options.restoreProgress }),
      },
    );
    const snapshots = transfer.snapshotCount;
    if (!options.apply)
      return session.direction === "push"
        ? { ...note, status: "push_ready" as const, snapshots, plan }
        : session.direction === "pull"
          ? { ...note, status: "pull_ready" as const, snapshots, plan }
          : {
              ...note,
              status: "merge_ready" as const,
              revision_id: remote?.revision_id,
              snapshots,
              collections_to_remove: session.collectionsToRemove,
              plan,
            };
    if (options.onPlan) yield* options.onPlan(plan);
    const restored = yield* transfer.restore();
    const prepared = yield* session.prepareLocal(restored);
    yield* prepared.checkCurrent;
    const copies = yield* progress.around({ kind: "save-local" }, prepared.applyLocal);
    installed += copies.installed;
    uninstalled += copies.uninstalled;
    yield* transfer.upload();
    const sentManifest = canonicalJson(target);
    const saved =
      !session.writeRemote && remote !== null
        ? remote
        : yield* progress.around(
            { kind: "save-remote" },
            transport.write(remote?.revision_id ?? null, structuredClone(target)).pipe(
              Effect.catch((failure) =>
                Effect.gen(function* () {
                  // A failed response does not establish whether the CAS committed. Read once;
                  // only the exact sent manifest proves acceptance of this write. The local save
                  // already recorded the remote head it merged; it did not accept the sent target.
                  const readBack = yield* transport.read.pipe(Effect.option);
                  if (
                    Option.isSome(readBack) &&
                    readBack.value !== null &&
                    (remote === null || readBack.value.library_id === remote.library_id) &&
                    canonicalJson(readBack.value.manifest) === sentManifest
                  )
                    return readBack.value;
                  if (
                    attempt < 2 &&
                    Option.isSome(readBack) &&
                    readBack.value !== null &&
                    (remote === null || readBack.value.library_id === remote.library_id) &&
                    readBack.value.revision_id !== remote?.revision_id &&
                    Object.keys(readBack.value.manifest).every((field) =>
                      Object.hasOwn(LibraryManifest.fields, field),
                    )
                  )
                    // Re-read and merge from the remote head incorporated by the local save.
                    // Bound contention retries;
                    // a head with unknown fields stays untouched rather than being projected away.
                    return { _tag: "Retry" as const };
                  return yield* Effect.fail(failure);
                }),
              ),
            ),
          );
    if ("_tag" in saved) continue;
    if (
      (remote !== null && saved.library_id !== remote.library_id) ||
      canonicalJson(saved.manifest) !== sentManifest
    )
      return yield* new StalePlan({
        reason: { _tag: "SyncPlanInvalid", reason: "receipt-mismatch" },
      });
    yield* accept({
      expectedBase: session.expectedBase,
      ancestry: {
        origin: options.origin,
        library_id: saved.library_id,
        revision_id: saved.revision_id,
        base_manifest: normalizeLibraryManifest(target),
      },
    });
    const syncStatus =
      session.direction === "push"
        ? ("pushed" as const)
        : session.direction === "pull"
          ? ("pulled" as const)
          : ("merged" as const);
    return {
      ...note,
      status: copies.enablementIssues.length ? ("enablement_incomplete" as const) : syncStatus,
      ...(copies.enablementIssues.length
        ? {
            sync_status: syncStatus,
            enablement_issues: copies.enablementIssues,
          }
        : {}),
      revision_id: saved.revision_id,
      snapshots,
      installed,
      uninstalled,
      plan,
    };
  }
}, Effect.scoped);
