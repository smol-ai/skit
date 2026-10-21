import { withLibraryWriter } from "@smolai/skit-core";
import { Data, Effect, Result } from "effect";
import {
  canonicalJson,
  currentLibraryManifest,
  LibraryStore,
  libraryManifestFromLocalStateEffect,
  type LibraryManifest,
  type ProjectionTarget,
  type RestoreObserver,
  deviceInstallationIntent,
  prepareDeviceInstallation,
  withDeviceSkillSelection,
  sameDeviceSkillSelection,
  bindingSkillIds,
} from "@smolai/skit-core";
import { inspectSyncSnapshots } from "./library-sync-inspection.js";
import { prepareSyncTransferEffect } from "./library-sync-snapshots.js";
import { silentSyncObserver, type SyncObserver } from "./library-sync-progress.js";
import { librarySyncApiEffect } from "./library-sync-api.js";
import { prepareLibraryMerge, normalizeLibraryManifest } from "./library-merge.js";
import { reconcileLibraryProjections } from "./projection-reconciliation.js";
import { planLibrarySync } from "./library-sync-plan.js";
import type { SyncPlan } from "./library-sync-contract.js";
import {
  prepareSyncDeviceTransition,
  resolveSyncProjectionCollisionsEffect,
} from "./library-sync-projections.js";
import { SyncConflictDetail } from "./library-sync-contract.js";
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core";
import { selectDeviceSkills } from "./device-selection.js";
import { OptionCombinationInvalid } from "../failures.js";
import { observeHarnessShadows } from "../../projection/harness-shadows.js";
import type { InventoryRootOptions } from "../../projection/roots.js";

const conflicted = (details: readonly SyncConflictDetail[], revision_id?: string) => ({
  status: "conflicted" as const,
  ...(revision_id === undefined ? {} : { revision_id }),
  conflicts: [...new Set(details.map((item) => item.key))].sort(),
  conflict_details: details,
});

const emptyManifest: LibraryManifest = currentLibraryManifest({
  collections: [],
  skills: [],
  retained_copies: [],
  acquisitions: [],
  bindings: [],
  snapshot_digests: [],
});
const same = (a: LibraryManifest, b: LibraryManifest) =>
  canonicalJson(normalizeLibraryManifest(a)) === canonicalJson(normalizeLibraryManifest(b));
const projectionCounts = (result: { readonly projected: number; readonly retired: number }) => ({
  projected: result.projected,
  retired: result.retired,
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
export const syncLibraryEffect = Effect.fn("Library.sync")(
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
    projection?: {
      rootFor: (target: ProjectionTarget) => string | undefined;
    };
    onPlan?: (plan: SyncPlan) => Effect.Effect<void>;
    observer?: SyncObserver;
    restoreObserver?: RestoreObserver;
  }) {
    const observer = options.observer ?? silentSyncObserver;

    const store = yield* LibraryStore;
    const projectionOptions = {
      home: store.home,
      variantsPath: store.variantsPath,
      ...(options.projection === undefined ? {} : { rootFor: options.projection.rootFor }),
    };
    const api = yield* librarySyncApiEffect({ origin: options.origin, token: options.token });
    const local = yield* observer.around({ kind: "inspect-local" }, store.inspect);
    const manifest = local.present
      ? yield* libraryManifestFromLocalStateEffect(local.state)
      : emptyManifest;
    const inventory = yield* inspectSyncSnapshots(
      local.present ? local.state.retained_copies : [],
      store.originalsPath,
      observer,
    );
    if (inventory._tag === "Changed")
      return { status: "local_bytes_changed" as const, digest: inventory.digest };

    const remote = yield* observer.around({ kind: "read-remote" }, api.read());

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
        yield* store.publish(withDeviceSkillSelection(state, selection, options.origin), state);
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
    // State and the base it was reconciled with are always published together, never apart.
    const ancestryAt = (
      receipt: { library_id: string; revision_id: string },
      reconciled: LibraryManifest,
    ) => ({
      origin: options.origin,
      library_id: receipt.library_id,
      revision_id: receipt.revision_id,
      base_manifest: normalizeLibraryManifest(reconciled),
    });

    const merge = yield* observer.around(
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
      (entry) =>
        `The selected ${entry.kind} ${entry.kind === "skill" ? entry.skill_id : entry.collection_id} is no longer in the Library; update this device's selection.`,
    );
    const collision = yield* observer.around(
      { kind: "check-destinations" },
      resolveSyncProjectionCollisionsEffect(
        installation.manifest,
        options.projection?.rootFor,
        options.keepEnabled,
        device,
      ),
    );
    if (collision.invalid) return { status: "resolution_invalid" as const, ...revision };
    if (collision.conflicts.length && !choosing)
      return conflicted(collision.conflicts, remote?.revision_id);
    const { account: desired, installation: effectiveManifest } = installation.resolveBindings(
      collision.manifest.bindings,
    );
    const transition = yield* observer.around(
      { kind: "check-projections" },
      prepareSyncDeviceTransition({
        current: local.present ? local.state : undefined,
        aligned: device,
        baseline: merge.device,
        manifest: effectiveManifest,
        rootFor: options.projection?.rootFor,
        deferDeviceConflicts: choosing,
      }),
    );
    if (transition._tag === "Conflicted")
      return conflicted(transition.conflicts, remote?.revision_id);
    const transitionIssues = transition.issues;

    if (clean) {
      // Nothing to transfer, write or retire. Publish only to anchor ancestry this state lacks,
      // and only onto the state compared with R.
      if (options.apply) {
        const sync_ancestry = ancestryAt(remote, remoteManifest);
        if (
          canonicalJson(local.state.sync_ancestry ?? null) !== canonicalJson(sync_ancestry) ||
          !sameDeviceSkillSelection(local.state, device)
        )
          yield* store
            .publish({ ...device, sync_ancestry }, local.state)
            .pipe(Effect.catchTag("LibraryChanged", () => Effect.fail(new SyncLocalChanged())));
      }
      const projections = options.apply
        ? yield* reconcileSelected()
        : { projected: 0, retired: 0, issues: [] as string[] };
      return {
        status: projections.issues.length ? ("enablement_incomplete" as const) : ("clean" as const),
        ...(projections.issues.length
          ? { sync_status: "clean" as const, enablement_issues: projections.issues }
          : {}),
        changed: false,
        revision_id: remote.revision_id,
        ...projectionCounts(projections),
      };
    }

    // Equivalent handle alignment alone is not a Collection content or evidence change.
    const plan = planLibrarySync(merge.alignedLocal, remoteManifest, desired);
    const transfer = yield* prepareSyncTransferEffect(inventory.archives, desired, remote, api, {
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
    // compare-and-swap on the revision this sync read, (4) retire the Projections the plan
    // removes or reidentifies, (5) publish local state with ancestry naming exactly the written
    // revision, onto exactly the state this sync planned from, (6) reconcile Projections. Remote
    // commits before local, so an interruption leaves R ahead of B and the next sync re-derives
    // the same result from the old base; local state never names a revision R does not hold.
    const restored = yield* transfer.restore();
    // A merge or pull rechecks L before the remote write; a push relies on the publish check.
    if (remote !== null) {
      const fresh = yield* store.inspect;
      if (
        fresh.present !== local.present ||
        (fresh.present && !same(yield* libraryManifestFromLocalStateEffect(fresh.state), manifest))
      )
        return yield* new SyncLocalChanged();
    }
    yield* transfer.upload();

    const saved =
      remote !== null && same(desired, remoteManifest)
        ? remote
        : yield* observer.around(
            { kind: "save-remote" },
            api.write(remote?.revision_id ?? null, desired),
          );
    // Local state is published only onto exactly what this plan describes. If it moved, the
    // device keeps its old ancestry and the next sync merges both changes.
    const retired = yield* observer.around(
      { kind: "save-local" },
      transition
        .publishRestored(restored.state, ancestryAt(saved, desired))
        .pipe(Effect.catchTag("LibraryChanged", () => Effect.fail(new SyncLocalChanged()))),
    );

    const projections = yield* reconcileSelected();
    const syncStatus =
      remote === null
        ? ("pushed" as const)
        : !local.present
          ? ("pulled" as const)
          : ("merged" as const);
    return {
      status: projections.issues.length ? ("enablement_incomplete" as const) : syncStatus,
      ...(projections.issues.length
        ? { sync_status: syncStatus, enablement_issues: projections.issues }
        : {}),
      revision_id: saved.revision_id,
      snapshots,
      ...projectionCounts(projections),
      retired: retired + projections.retired,
      plan,
    };

    function reconcileSelected() {
      return Effect.gen(function* () {
        if (!choosing) {
          const result = yield* observer.around(
            { kind: "enable" },
            reconcileLibraryProjections({
              ...projectionOptions,
              includeRepositoryBindings: true,
            }),
          );
          return { ...projectionCounts(result), issues: [] as string[] };
        }
        const issues = [
          ...missingSelection,
          ...collision.conflicts.map((conflict) => conflict.message),
          ...transitionIssues.map((conflict) => conflict.message),
        ];
        const state = yield* store.load;
        if (choosing && options.inventory !== undefined) {
          const ids = new Set(
            deviceInstallationIntent(state).bindings.flatMap((binding) =>
              bindingSkillIds(state, binding),
            ),
          );
          const names = state.skills
            .filter((skill) => ids.has(skill.skill_id))
            .map((skill) => skill.name);
          if (names.length) {
            const observed = yield* Effect.result(
              observeHarnessShadows(options.inventory, { kind: "global" }, names),
            );
            if (Result.isFailure(observed))
              issues.push(
                `Could not inspect existing Skill installations: ${String(observed.failure)}`,
              );
            else
              for (const shadow of observed.success)
                issues.push(
                  `${shadow.name} already exists at ${shadow.aliases.map((alias) => (alias.linkPath === undefined ? alias.path : `${alias.path} (symlink ${alias.linkPath} → ${alias.linkTarget})`)).join(", ")} (resolved: ${shadow.canonicalPath}); review it before enabling.`,
                );
          }
        }
        if (issues.length) return { projected: 0, retired: 0, issues };
        const attempt = yield* Effect.result(
          observer.around(
            { kind: "enable" },
            reconcileLibraryProjections({
              ...projectionOptions,
              includeRepositoryBindings: true,
            }),
          ),
        );
        if (Result.isFailure(attempt))
          return {
            projected: 0,
            retired: 0,
            issues: [`Enablement failed: ${String(attempt.failure)}`],
          };
        const after = yield* store.load;
        const ids = new Set(
          deviceInstallationIntent(after).bindings.flatMap((binding) =>
            bindingSkillIds(after, binding),
          ),
        );
        for (const projection of after.projections.filter(
          (item) =>
            ids.has(item.skill_id) &&
            item.status === "conflicted" &&
            (item.target === "agents" || item.target === "claude") &&
            options.projection?.rootFor(item.target) !== undefined,
        ))
          issues.push(
            `Cannot install at ${projection.path}: existing content or ownership conflicts. Preserve it and review before retrying.`,
          );
        return { ...projectionCounts(attempt.success), issues };
      });
    }
  },
  (effect, options) => (options.apply ? withLibraryWriter(effect) : effect),
);
