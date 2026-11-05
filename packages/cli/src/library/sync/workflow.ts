import { Library } from "@smolai/skit-core/library";
import {
  resolveSyncInstalledSkillCollisions,
  previewSyncInstalledSkills,
} from "@smolai/skit-core/library/session";
import { Data, Effect, Option } from "effect";
import {
  canonicalJson,
  currentLibraryManifest,
  libraryManifestFromLocalState,
  type LibraryManifest,
  type InstallDestination,
  type RestoreProgress,
  prepareDeviceInstallation,
  withDeviceSkillSelection,
  FailureTypeId,
  type SkitFailure,
} from "@smolai/skit-core";
import { inspectSyncSnapshots } from "./inspection.js";
import { prepareSyncTransfer } from "./snapshots.js";
import { silentSyncProgress, type SyncProgress } from "./progress.js";
import { librarySyncApi } from "./api.js";
import { prepareLibraryMerge, normalizeLibraryManifest } from "./merge.js";
import { planLibrarySync } from "./plan.js";
import { type SyncPlan, SyncConflictDetail } from "./output.js";

import { selectDeviceSkills } from "./device-selection.js";
import { OptionCombinationInvalid } from "../../commands/input-failures.js";
import type { InventoryRootOptions } from "@smolai/skit-core/library/routing";

const conflicted = (details: readonly SyncConflictDetail[], revision_id?: string) => ({
  status: "conflicted" as const,
  ...(revision_id === undefined ? {} : { revision_id }),
  conflicts: [...new Set(details.map((item) => item.key))].sort(),
  conflict_details: details,
});

const emptyManifest: LibraryManifest = currentLibraryManifest({
  collections: [],
  skills: [],
  collection_versions: [],
  imports: [],
  enabled: [],
  snapshot_digests: [],
});
const same = (a: LibraryManifest, b: LibraryManifest) =>
  canonicalJson(normalizeLibraryManifest(a)) === canonicalJson(normalizeLibraryManifest(b));
export class SyncLocalChanged
  extends Data.TaggedError("Library.SyncLocalChanged")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Run `skit sync` again.";
  get message(): string {
    return "The local Library changed while sync was running";
  }
}
/**
 * Sync is one three-way merge of this device's Library (L) with the remote head (R) from their
 * accepted base (B). A push merges L with an absent R, a pull an absent L with R, and a clean sync
 * is a merge whose result is both sides. Absent and empty stay distinct: only two existing
 * Libraries can be clean or need adoption, and only an absent R is created by the write.
 */
export const syncLibrary = Effect.fn("Library.sync")(function* (options: {
  origin: string;
  token?: string;
  apply: boolean;
  adopt?: boolean;
  takeRemote?: readonly string[];
  keepEnabled?: readonly string[];
  deviceSelection?:
    | "follow-account"
    | { readonly skills: readonly string[]; readonly collections: readonly string[] };
  inventory?: InventoryRootOptions;
  installedSkill?: {
    rootFor: (target: InstallDestination) => string | undefined;
  };
  onPlan?: (plan: SyncPlan) => Effect.Effect<void>;
  progress?: SyncProgress;
  restoreProgress?: RestoreProgress;
}) {
  const progress = options.progress ?? silentSyncProgress;

  const api = yield* librarySyncApi({ origin: options.origin, token: options.token });
  const library = yield* Library.Service;
  const snapshot = yield* progress.around({ kind: "inspect-local" }, library.read);
  const local =
    snapshot._tag === "Present"
      ? { present: true as const, state: snapshot.state }
      : { present: false as const };
  const manifest = local.present
    ? yield* libraryManifestFromLocalState(local.state)
    : emptyManifest;
  const inventory = yield* inspectSyncSnapshots(snapshot, progress);
  if (inventory._tag === "Changed")
    return { status: "local_bytes_changed" as const, hash: inventory.hash };

  const remote = yield* progress.around({ kind: "read-remote" }, api.read());

  const ancestry = local.present ? local.state.sync_ancestry : undefined;
  const mismatched =
    ancestry !== undefined &&
    (ancestry.origin !== options.origin ||
      remote === null ||
      ancestry.library_id !== remote.library_id);
  if (mismatched && !options.adopt)
    return {
      status: "base_mismatch" as const,
      ...(remote === null ? {} : { revision_id: remote.revision_id }),
    };
  if (remote === null && !local.present) {
    if (options.apply && options.deviceSelection !== undefined) {
      const selection =
        options.deviceSelection === "follow-account"
          ? { mode: "follow-account" as const }
          : yield* selectDeviceSkills(emptyManifest, options.deviceSelection);
      const staged = yield* library.content.stage(emptyManifest, {
        localArchives: [],
        registry: { origin: options.origin, token: Option.fromUndefinedOr(options.token) },
      });
      const plan = yield* library.plan(
        {
          _tag: "Sync",
          staged,
          deviceSelection: Option.some(selection),
          pendingOrigin: Option.some(options.origin),
          acceptedBase: Option.none(),
          remote: Option.none(),
        },
        { base: snapshot },
      );
      if (Library.isRemoteSyncPlan(plan)) return yield* new SyncLocalChanged();
      yield* library.apply({ _tag: "Apply", plan });
    }
    return { status: "clean" as const, changed: false };
  }
  // Explicit adoption sets aside ancestry from another Library. Against an empty base the merge
  // can only add records, never infer a deletion.
  const accepted = mismatched ? undefined : ancestry;
  const remoteManifest = remote?.manifest ?? emptyManifest;
  const revision = remote === null ? {} : { revision_id: remote.revision_id };
  const equalToRemote = local.present && remote !== null && same(manifest, remoteManifest);
  const clean = equalToRemote && !options.keepEnabled?.length;
  if (
    local.present &&
    remote !== null &&
    accepted === undefined &&
    !options.adopt &&
    !equalToRemote &&
    !(
      local.state.pending_device_selection_origin === options.origin &&
      same(manifest, emptyManifest)
    )
  )
    return { status: "adoption_required" as const, revision_id: remote.revision_id };
  const base = accepted?.base_manifest ?? (equalToRemote ? remoteManifest : emptyManifest);
  // State and the base it was reconciled with are always saved together, never apart.
  const ancestryAt = (
    remote: { library_id: string; revision_id: string },
    merged: LibraryManifest,
  ) => ({
    origin: options.origin,
    library_id: remote.library_id,
    revision_id: remote.revision_id,
    base_manifest: normalizeLibraryManifest(merged),
  });

  const merge = yield* progress.around(
    { kind: "merge" },
    prepareLibraryMerge({
      base,
      local: manifest,
      remote: remoteManifest,
      ...(local.present ? { device: local.state } : {}),
      ...(options.takeRemote === undefined ? {} : { takeRemote: options.takeRemote }),
    }),
  );
  if (merge._tag === "InvalidResolution")
    return { status: "resolution_invalid" as const, ...revision };
  if (merge._tag === "Conflicted") return conflicted(merge.conflicts, remote?.revision_id);
  const selected =
    options.deviceSelection === undefined
      ? undefined
      : options.deviceSelection === "follow-account"
        ? { mode: "follow-account" as const }
        : yield* selectDeviceSkills(merge.manifest, options.deviceSelection);
  const device = withDeviceSkillSelection(merge.device, selected);
  const installation = prepareDeviceInstallation(device, merge.manifest);
  const choosing = installation.independent;
  if (choosing && options.keepEnabled?.length)
    return yield* new OptionCombinationInvalid({
      detail:
        "--keep-enabled changes account bindings and cannot be combined with a device selection.",
    });
  const collision = yield* progress.around(
    { kind: "check-destinations" },
    resolveSyncInstalledSkillCollisions(
      installation.manifest,
      options.installedSkill?.rootFor,
      options.keepEnabled,
      device,
    ),
  );
  if (collision.invalid) return { status: "resolution_invalid" as const, ...revision };
  if (collision.conflicts.length && !choosing)
    return conflicted(collision.conflicts, remote?.revision_id);
  const { account: desired, installation: effectiveManifest } = installation.resolveEnabled(
    collision.manifest.enabled,
  );
  const transition = local.present
    ? yield* progress.around(
        { kind: "check-installed-skills" },
        previewSyncInstalledSkills(
          local.state,
          device,
          effectiveManifest,
          options.installedSkill?.rootFor,
          choosing,
        ),
      )
    : undefined;
  if (transition?.conflicts.length) return conflicted(transition.conflicts, remote?.revision_id);

  const prepareLocal = (staged: Library.StagedContent) =>
    library
      .plan(
        {
          _tag: "Sync",
          staged,
          acceptedBase: Option.fromUndefinedOr(ancestry),
          deviceSelection: Option.fromUndefinedOr(selected),
          pendingOrigin: Option.none(),
          remote: Option.some({
            origin: options.origin,
            libraryId: Option.fromNullishOr(remote?.library_id),
          }),
        },
        { base: snapshot },
      )
      .pipe(Effect.filterOrFail(Library.isRemoteSyncPlan, () => new SyncLocalChanged()));
  const applyLocal = (
    plan: Library.RemoteSyncPlan,
    saved: { readonly library_id: string; readonly revision_id: string },
    desired: LibraryManifest,
  ) =>
    library
      .apply({
        _tag: "ApplySynced",
        plan,
        receipt: {
          origin: options.origin,
          libraryId: saved.library_id,
          revisionId: saved.revision_id,
          manifestDigest: plan.change.staged.manifestDigest,
          ancestry: ancestryAt(saved, desired),
        },
      })
      .pipe(
        Effect.map((outcome) => outcome.result),
        Effect.catchTag("Library.StalePlan", () => Effect.fail(new SyncLocalChanged())),
      );

  if (clean) {
    const installedSkills = options.apply
      ? yield* Effect.gen(function* () {
          const staged = yield* library.content.stage(remoteManifest, {
            localArchives: inventory.archives,
            registry: { origin: options.origin, token: Option.fromUndefinedOr(options.token) },
          });
          const plan = yield* prepareLocal(staged);
          return yield* progress.around(
            { kind: "save-local" },
            applyLocal(plan, remote, remoteManifest),
          );
        })
      : { installed: 0, uninstalled: 0, enablementIssues: [] as readonly string[] };
    return {
      status: installedSkills.enablementIssues.length
        ? ("enablement_incomplete" as const)
        : ("clean" as const),
      ...(installedSkills.enablementIssues.length
        ? { sync_status: "clean" as const, enablement_issues: installedSkills.enablementIssues }
        : {}),
      changed: false,
      revision_id: remote.revision_id,
      installed: installedSkills.installed,
      uninstalled: installedSkills.uninstalled,
    };
  }

  // Equivalent handle alignment alone is not a Collection content or evidence change.
  const plan: SyncPlan = {
    ...planLibrarySync(merge.alignedLocal, remoteManifest, desired),
    ...(merge.enabledResolution ? { enabled_resolution: merge.enabledResolution } : {}),
  };
  const transfer = yield* prepareSyncTransfer(inventory.archives, desired, remote, api, {
    ...options,
  });
  const snapshots = transfer.snapshotCount;
  if (!options.apply)
    return remote === null
      ? { status: "push_ready" as const, snapshots, plan }
      : !local.present
        ? { status: "pull_ready" as const, snapshots, plan }
        : {
            status: accepted === undefined ? ("adoption_ready" as const) : ("merge_ready" as const),
            revision_id: remote.revision_id,
            snapshots,
            collections_to_remove: local.state.collections.filter(
              (collection) =>
                !desired.collections.some(
                  (candidate) => candidate.collection_id === collection.collection_id,
                ),
            ).length,
            plan,
          };
  if (options.onPlan) yield* options.onPlan(plan);

  // Transport commits the remote head; Library verifies the receipt and owns every local effect.
  const restored = yield* transfer.restore();
  const localPlan = yield* prepareLocal(restored);
  // A merge or pull rechecks L before the remote write; a push relies on the save check.
  if (remote !== null) {
    if ((yield* library.read).revision !== snapshot.revision) return yield* new SyncLocalChanged();
  }
  yield* transfer.upload();

  const saved =
    remote !== null && same(desired, remoteManifest)
      ? remote
      : yield* progress.around(
          { kind: "save-remote" },
          api.write(remote?.revision_id ?? null, desired),
        );
  const installedSkills = yield* progress.around(
    { kind: "save-local" },
    applyLocal(localPlan, saved, desired),
  );
  const syncStatus =
    remote === null
      ? ("pushed" as const)
      : !local.present
        ? ("pulled" as const)
        : ("merged" as const);
  return {
    status: installedSkills.enablementIssues.length
      ? ("enablement_incomplete" as const)
      : syncStatus,
    ...(installedSkills.enablementIssues.length
      ? { sync_status: syncStatus, enablement_issues: installedSkills.enablementIssues }
      : {}),
    revision_id: saved.revision_id,
    snapshots,
    installed: installedSkills.installed,
    uninstalled: installedSkills.uninstalled,
    plan,
  };
});
