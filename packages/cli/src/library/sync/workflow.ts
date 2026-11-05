import { Library } from "@smolai/skit-core/library";
import { openSyncSession } from "@smolai/skit-core/library/session";
import { Effect, Option } from "effect";
import type { InstallDestination, RestoreProgress } from "@smolai/skit-core";
import { inspectSyncSnapshots } from "./inspection.js";
import { prepareSyncTransfer } from "./snapshots.js";
import { silentSyncProgress, type SyncProgress } from "./progress.js";
import { librarySyncApi } from "./api.js";
import type { SyncPlan } from "./output.js";
import type { InventoryRootOptions } from "@smolai/skit-core/library/routing";

/** Transport stays here; Library owns the reviewed merge and every local decision/effect. */
export const syncLibrary = Effect.fn("Library.sync")(function* (options: {
  origin: string;
  token?: string;
  apply: boolean;
  takeRemote?: readonly string[];
  keepEnabled?: readonly string[];
  deviceSelection?:
    | "follow-account"
    | { readonly skills: readonly string[]; readonly collections: readonly string[] };
  inventory?: InventoryRootOptions;
  installedSkill?: { rootFor: (target: InstallDestination) => string | undefined };
  onPlan?: (plan: SyncPlan) => Effect.Effect<void>;
  progress?: SyncProgress;
  restoreProgress?: RestoreProgress;
}) {
  const progress = options.progress ?? silentSyncProgress;
  const api = yield* librarySyncApi({ origin: options.origin, token: options.token });
  const library = yield* Library.Service;
  const snapshot = yield* progress.around({ kind: "inspect-local" }, library.read);
  const inventory = yield* inspectSyncSnapshots(snapshot, progress);
  if (inventory._tag === "Changed")
    return { status: "local_bytes_changed" as const, hash: inventory.hash };
  const remote = yield* progress.around({ kind: "read-remote" }, api.read());
  const session = yield* openSyncSession(
    {
      origin: options.origin,
      remote,
      ...(options.takeRemote === undefined ? {} : { takeRemote: options.takeRemote }),
      ...(options.keepEnabled === undefined ? {} : { keepEnabled: options.keepEnabled }),
      ...(options.deviceSelection === undefined
        ? {}
        : { deviceSelection: options.deviceSelection }),
      ...(options.installedSkill === undefined ? {} : { rootFor: options.installedSkill.rootFor }),
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
            registry: { origin: options.origin, token: Option.fromUndefinedOr(options.token) },
          });
          const prepared = yield* session.prepare(staged);
          return yield* progress.around({ kind: "save-local" }, prepared.apply(remote));
        })
      : { installed: 0, uninstalled: 0, enablementIssues: [] as readonly string[] };
    return {
      ...note,
      status: copies.enablementIssues.length
        ? ("enablement_incomplete" as const)
        : ("clean" as const),
      ...(copies.enablementIssues.length
        ? { sync_status: "clean" as const, enablement_issues: copies.enablementIssues }
        : {}),
      changed: false,
      revision_id: remote.revision_id,
      installed: copies.installed,
      uninstalled: copies.uninstalled,
    };
  }
  const transfer = yield* prepareSyncTransfer(inventory.archives, target, remote, api, options);
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
  const prepared = yield* session.prepare(restored);
  yield* prepared.checkCurrent;
  yield* transfer.upload();
  const saved =
    !session.writeRemote && remote !== null
      ? remote
      : yield* progress.around(
          { kind: "save-remote" },
          api.write(remote?.revision_id ?? null, target),
        );
  const copies = yield* progress.around({ kind: "save-local" }, prepared.apply(saved));
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
      ? { sync_status: syncStatus, enablement_issues: copies.enablementIssues }
      : {}),
    revision_id: saved.revision_id,
    snapshots,
    installed: copies.installed,
    uninstalled: copies.uninstalled,
    plan,
  };
});
