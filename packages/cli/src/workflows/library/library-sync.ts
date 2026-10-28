import { withLibraryWriter } from "@smolai/skit-core";
import { Data, Effect, Result } from "effect";
import {
  canonicalJson,
  currentLibraryManifest,
  LibraryStore,
  libraryManifestFromLocalState,
  type LibraryManifest,
  type InstallDestination,
  type RestoreProgress,
  deviceInstallationIntent,
  prepareDeviceInstallation,
  withDeviceSkillSelection,
  sameDeviceSkillSelection,
  enabledSkillIds,
} from "@smolai/skit-core";
import { inspectSyncSnapshots } from "./library-sync-inspection.js";
import { prepareSyncTransfer } from "./library-sync-snapshots.js";
import { silentSyncProgress, type SyncProgress } from "./library-sync-progress.js";
import { librarySyncApi } from "./library-sync-api.js";
import { prepareLibraryMerge, normalizeLibraryManifest } from "./library-merge.js";
import { updateInstalledSkills } from "./update-installed-skills.js";
import { planLibrarySync } from "./library-sync-plan.js";
import type { SyncPlan } from "./library-sync-contract.js";
import {
  prepareSyncDeviceTransition,
  resolveSyncInstalledSkillCollisions,
} from "./library-sync-installed-skills.js";
import { SyncConflictDetail } from "./library-sync-contract.js";
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core";
import { selectDeviceSkills } from "./device-selection.js";
import { OptionCombinationInvalid } from "../failures.js";
import { findDuplicates } from "../../install/duplicates.js";
import type { InventoryRootOptions } from "../../install/roots.js";

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
const installedSkillCounts = (result: {
  readonly installed: number;
  readonly uninstalled: number;
}) => ({
  installed: result.installed,
  uninstalled: result.uninstalled,
});
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
export const syncLibrary = Effect.fn("Library.sync")(
  function* (options: {
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

    const store = yield* LibraryStore;
    const installedSkillOptions = {
      home: store.home,
      variantsPath: store.variantsPath,
      ...(options.installedSkill === undefined ? {} : { rootFor: options.installedSkill.rootFor }),
    };
    const api = yield* librarySyncApi({ origin: options.origin, token: options.token });
    const local = yield* progress.around({ kind: "inspect-local" }, store.inspect);
    const manifest = local.present
      ? yield* libraryManifestFromLocalState(local.state)
      : emptyManifest;
    const inventory = yield* inspectSyncSnapshots(
      local.present ? local.state.collection_versions : [],
      store.originalsPath,
      progress,
    );
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
        const state = yield* store.load;
        const selection =
          options.deviceSelection === "follow-account"
            ? { mode: "follow-account" as const }
            : yield* selectDeviceSkills(emptyManifest, options.deviceSelection);
        yield* store.save(withDeviceSkillSelection(state, selection, options.origin), state);
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
    const missingSelection = installation.missing.map(
      (item) =>
        `The selected ${"skill" in item ? `skill ${item.skill}` : `collection ${item.collection}`} is no longer in the Library; update this device's selection.`,
    );
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
    const transition = yield* progress.around(
      { kind: "check-installed-skills" },
      prepareSyncDeviceTransition({
        current: local.present ? local.state : undefined,
        aligned: device,
        baseline: merge.device,
        manifest: effectiveManifest,
        rootFor: options.installedSkill?.rootFor,
        deferDeviceConflicts: choosing,
      }),
    );
    if (transition._tag === "Conflicted")
      return conflicted(transition.conflicts, remote?.revision_id);
    const transitionIssues = transition.issues;

    if (clean) {
      // Nothing to transfer, write or retire. Save only to anchor ancestry this state lacks,
      // and only onto the state compared with R.
      if (options.apply) {
        const sync_ancestry = ancestryAt(remote, remoteManifest);
        if (
          canonicalJson(local.state.sync_ancestry ?? null) !== canonicalJson(sync_ancestry) ||
          !sameDeviceSkillSelection(local.state, device)
        )
          yield* store
            .save({ ...device, sync_ancestry }, local.state)
            .pipe(Effect.catchTag("LibraryChanged", () => Effect.fail(new SyncLocalChanged())));
      }
      const installedSkills = options.apply
        ? yield* updateSelectedSkills()
        : { installed: 0, uninstalled: 0, issues: [] as string[] };
      return {
        status: installedSkills.issues.length
          ? ("enablement_incomplete" as const)
          : ("clean" as const),
        ...(installedSkills.issues.length
          ? { sync_status: "clean" as const, enablement_issues: installedSkills.issues }
          : {}),
        changed: false,
        revision_id: remote.revision_id,
        installed: installedSkills.installed,
        uninstalled: installedSkills.uninstalled,
      };
    }

    // Equivalent handle alignment alone is not a Collection content or evidence change.
    const plan = planLibrarySync(merge.alignedLocal, remoteManifest, desired);
    const transfer = yield* prepareSyncTransfer(inventory.archives, desired, remote, api, {
      ...options,
      originalsPath: store.originalsPath,
    });
    const snapshots = transfer.snapshotCount;
    if (!options.apply)
      return remote === null
        ? { status: "push_ready" as const, snapshots, plan }
        : !local.present
          ? { status: "pull_ready" as const, snapshots, plan }
          : {
              status:
                accepted === undefined ? ("adoption_ready" as const) : ("merge_ready" as const),
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

    // The commit order, decided here and nowhere else: (1) retain every copy the result
    // references, (2) upload every snapshot the new head references, (3) write the head by
    // compare-and-swap on the revision this sync read, (4) retire the installed skills the plan
    // removes or reidentifies, (5) save local state with ancestry naming exactly the written
    // revision, onto exactly the state this sync planned from, (6) reconcile installed skills. Remote
    // commits before local, so an interruption leaves R ahead of B and the next sync re-derives
    // the same result from the old base; local state never names a revision R does not hold.
    const restored = yield* transfer.restore();
    // A merge or pull rechecks L before the remote write; a push relies on the save check.
    if (remote !== null) {
      const fresh = yield* store.inspect;
      if (
        fresh.present !== local.present ||
        (fresh.present && !same(yield* libraryManifestFromLocalState(fresh.state), manifest))
      )
        return yield* new SyncLocalChanged();
    }
    yield* transfer.upload();

    const saved =
      remote !== null && same(desired, remoteManifest)
        ? remote
        : yield* progress.around(
            { kind: "save-remote" },
            api.write(remote?.revision_id ?? null, desired),
          );
    // Local state is saved only onto exactly what this plan describes. If it moved, the
    // device keeps its old ancestry and the next sync merges both changes.
    const uninstalled = yield* progress.around(
      { kind: "save-local" },
      transition
        .saveRestored(restored.state, ancestryAt(saved, desired))
        .pipe(Effect.catchTag("LibraryChanged", () => Effect.fail(new SyncLocalChanged()))),
    );

    const installedSkills = yield* updateSelectedSkills();
    const syncStatus =
      remote === null
        ? ("pushed" as const)
        : !local.present
          ? ("pulled" as const)
          : ("merged" as const);
    return {
      status: installedSkills.issues.length ? ("enablement_incomplete" as const) : syncStatus,
      ...(installedSkills.issues.length
        ? { sync_status: syncStatus, enablement_issues: installedSkills.issues }
        : {}),
      revision_id: saved.revision_id,
      snapshots,
      installed: installedSkills.installed,
      uninstalled: uninstalled + installedSkills.uninstalled,
      plan,
    };

    function updateSelectedSkills() {
      return Effect.gen(function* () {
        if (!choosing) {
          const result = yield* progress.around(
            { kind: "enable" },
            updateInstalledSkills({
              ...installedSkillOptions,
              includeRepositories: true,
            }),
          );
          return { ...installedSkillCounts(result), issues: [] as string[] };
        }
        const issues = [
          ...missingSelection,
          ...collision.conflicts.map((conflict) => conflict.message),
          ...transitionIssues.map((conflict) => conflict.message),
        ];
        const state = yield* store.load;
        if (choosing && options.inventory !== undefined) {
          const ids = new Set(
            deviceInstallationIntent(state).globals.flatMap((global) =>
              enabledSkillIds(state, global.enabled),
            ),
          );
          const names = state.skills
            .filter((skill) => ids.has(skill.skill_id))
            .map((skill) => skill.name);
          if (names.length) {
            const observed = yield* Effect.result(
              findDuplicates(options.inventory, { kind: "global" }, names),
            );
            if (Result.isFailure(observed))
              issues.push(
                `Could not inspect existing Skill installations: ${String(observed.failure)}`,
              );
            else
              for (const duplicate of observed.success)
                issues.push(
                  `${duplicate.name} already exists at ${duplicate.aliases.map((alias) => (alias.linkPath === undefined ? alias.path : `${alias.path} (symlink ${alias.linkPath} → ${alias.linkTarget})`)).join(", ")} (resolved: ${duplicate.canonicalPath}); review it before enabling.`,
                );
          }
        }
        if (issues.length) return { installed: 0, uninstalled: 0, issues };
        const attempt = yield* Effect.result(
          progress.around(
            { kind: "enable" },
            updateInstalledSkills({
              ...installedSkillOptions,
              includeRepositories: true,
            }),
          ),
        );
        if (Result.isFailure(attempt))
          return {
            installed: 0,
            uninstalled: 0,
            issues: [`Enablement failed: ${String(attempt.failure)}`],
          };
        const after = yield* store.load;
        const ids = new Set(
          deviceInstallationIntent(after).globals.flatMap((global) =>
            enabledSkillIds(after, global.enabled),
          ),
        );
        for (const installedSkill of after.installed_skills.filter(
          (item) =>
            ids.has(item.skill_id) &&
            item.status === "conflicted" &&
            (item.destination === "agents" || item.destination === "claude") &&
            options.installedSkill?.rootFor(item.destination) !== undefined,
        ))
          issues.push(
            `Cannot install at ${installedSkill.path}: existing content or ownership conflicts. Preserve it and review before retrying.`,
          );
        return { ...installedSkillCounts(attempt.success), issues };
      });
    }
  },
  (effect, options) => (options.apply ? withLibraryWriter(effect) : effect),
);
