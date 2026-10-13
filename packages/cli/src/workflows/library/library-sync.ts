import { emptyLibraryState, withLibraryWriter } from "@smolai/skit-core";
import { Data, Effect } from "effect";
import {
  canonicalJson,
  blendRestoredStateEffect,
  captureSnapshotArchiveEffect,
  completeRestoreArchivesEffect,
  currentLibraryManifest,
  deterministicTreeHashEffect,
  LibraryState,
  LibraryStore,
  libraryManifestFromLocalStateEffect,
  prepareRestoreEffect,
  prepareObservedCollectionEffect,
  acquisitionIsSourceRestorable,
  resolveSkitSourceEffect,
  retainedTreePath,
  type Acquisition,
  type LibraryManifest,
  type ProjectionTarget,
  type SkitSource,
  type SnapshotArchive,
} from "@smolai/skit-core";
import { join } from "node:path";
import { librarySyncApiEffect } from "./library-sync-api.js";
import {
  mergeLibraryManifests,
  normalizeLibraryManifest,
  describeLibraryMergeConflicts,
} from "./library-merge.js";
import { reconcileLibraryProjections } from "./projection-reconciliation.js";
import { planLibrarySync } from "./library-sync-plan.js";
import type { SyncPlan } from "./library-sync-contract.js";
import { alignLibrary, aliasDevice, aliasManifest } from "./library-alignment.js";
import {
  planSyncProjectionsEffect,
  resolveSyncProjectionCollisionsEffect,
  retireSyncProjectionsEffect,
} from "./library-sync-projections.js";
import { SyncConflictDetail } from "./library-sync-contract.js";
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core";

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
export class SyncSourceRestoreInvalid
  extends Data.TaggedError("Library.SyncSourceRestoreInvalid")<{
    digest: string;
    detail: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation =
    "Restore access to the source, or run `skit update` on the Collection, then run `skit sync` again.";
  get message(): string {
    return this.detail;
  }
}

/**
 * The Source to reacquire an Acquisition's exact bytes from: its recorded identity at its
 * revision. Git restores pin the commit separately; a Registry restore names the Release.
 */
export const restorableSource = (acquisition: Acquisition): SkitSource | undefined => {
  const identity = acquisition.source_identity;
  const subpath =
    (identity.kind === "github" || identity.kind === "git") && identity.collection_root !== "."
      ? { subpath: identity.collection_root }
      : {};
  switch (identity.kind) {
    case "github":
      return {
        type: "github",
        owner: identity.owner,
        repository: identity.repository,
        ...subpath,
      };
    case "git":
      return { type: "git", remote: identity.remote.value, ...subpath };
    case "registry":
      return acquisition.revision === undefined
        ? undefined
        : {
            type: "registry",
            namespace: identity.namespace,
            slug: identity.slug,
            version: acquisition.revision,
            ...(identity.authority === "default" ? {} : { authority: identity.authority }),
          };
    default:
      return undefined;
  }
};

const reacquireSourceArchiveEffect = Effect.fn("Library.sync.reacquireSource")(function* (
  manifest: LibraryManifest,
  digest: string,
  options: { origin: string; token?: string },
) {
  const copy = manifest.retained_copies.find((candidate) => candidate.digest === digest);
  const acquisition = manifest.acquisitions.find(
    (candidate) =>
      candidate.retained_copy_id === copy?.retained_copy_id &&
      acquisitionIsSourceRestorable(candidate),
  );
  if (copy === undefined || acquisition === undefined)
    return yield* new SyncSourceRestoreInvalid({
      digest,
      detail: "manifest has no exact source-restoration acquisition",
    });
  const archive = yield* Effect.scoped(
    Effect.gen(function* () {
      const gitSource =
        acquisition.source_identity.kind === "github" || acquisition.source_identity.kind === "git";
      const commit = gitSource ? acquisition.revision : undefined;
      if (gitSource && commit === undefined)
        return yield* new SyncSourceRestoreInvalid({
          digest,
          detail: "pinned Git acquisition has no commit",
        });
      const source = restorableSource(acquisition);
      if (source === undefined)
        return yield* new SyncSourceRestoreInvalid({
          digest,
          detail: "acquisition has no restorable source identity",
        });
      const profiles = new Set(copy.members.map((member) => member.materialization_profile));
      if (profiles.size !== 1)
        return yield* new SyncSourceRestoreInvalid({
          digest,
          detail: "retained copy has no single materialization profile",
        });
      const resolved = yield* resolveSkitSourceEffect(source, {
        registryBaseUrl: options.origin,
        ...(options.token === undefined ? {} : { registryToken: options.token }),
        ...(commit === undefined
          ? {}
          : { git: { commit, tracking_ref: null }, requireGitRevision: true }),
      });
      // Declared imports retain the whole resolved SKIT root, including shared and non-Skill files.
      if (profiles.has("declared-skit-skill/v1")) {
        if (resolved.descriptorKind !== "declared")
          return yield* new SyncSourceRestoreInvalid({
            digest,
            detail: "declared retained copy source has no declared Descriptor",
          });
        return yield* captureSnapshotArchiveEffect(resolved.root);
      }
      const prepared = yield* prepareObservedCollectionEffect(
        yield* Effect.forEach(copy.members, (member) =>
          Effect.gen(function* () {
            const sourcePath =
              member.source_path === "."
                ? resolved.originalRoot
                : join(resolved.originalRoot, member.source_path);
            return {
              name: member.source_path,
              sourcePath,
              relativePath: member.source_path,
              observedHash: yield* deterministicTreeHashEffect(sourcePath),
            };
          }),
        ),
      );
      return yield* captureSnapshotArchiveEffect(prepared.staged);
    }),
  );
  if (archive.digest !== digest)
    return yield* new SyncSourceRestoreInvalid({
      digest,
      detail: `source returned ${archive.digest}; expected ${digest}`,
    });
  return archive;
});

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
    projection?: {
      variantsPath: string;
      rootFor: (target: ProjectionTarget) => string | undefined;
    };
    onPlan?: (plan: SyncPlan) => Effect.Effect<void>;
    onProgress?: (message: string) => Effect.Effect<void>;
  }) {
    const progress = (message: string) => options.onProgress?.(message) ?? Effect.void;
    yield* progress("Inspecting this device’s Library");
    const store = yield* LibraryStore;
    const projectionOptions = {
      home: store.home,
      variantsPath: options.projection?.variantsPath ?? store.originalsPath,
      ...(options.projection === undefined ? {} : { rootFor: options.projection.rootFor }),
    };
    const api = yield* librarySyncApiEffect({ origin: options.origin, token: options.token });
    const local = yield* store.inspect;
    let manifest = emptyManifest;
    const localArchives: SnapshotArchive[] = [];
    if (local.present) {
      manifest = yield* libraryManifestFromLocalStateEffect(local.state);
      let verified = 0;
      for (const tree of local.state.retained_copies) {
        yield* progress(
          `Verifying retained copies · ${verified}/${local.state.retained_copies.length}`,
        );
        const archive = yield* captureSnapshotArchiveEffect(
          retainedTreePath(store.originalsPath, tree.digest),
        );
        if (archive.digest !== tree.digest)
          return { status: "local_bytes_changed" as const, digest: tree.digest };
        if (!localArchives.some((candidate) => candidate.digest === archive.digest))
          localArchives.push(archive);
        verified++;
      }
    }
    yield* progress("Reading remote Library");
    const remote = yield* api.read();
    yield* progress("Planning Library sync");
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
    if (remote === null && !local.present) return { status: "clean" as const, changed: false };
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
      !equalToRemote
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

    // One alias map renames every side that holds independently created records. The device is
    // rebuilt through the Library schema, so sync carries only the fields this CLI declares.
    const aliases = alignLibrary(manifest, remoteManifest, base);
    const aligned = aliasManifest(manifest, aliases);
    const alignedBase = aliasManifest(base, aliases);
    const device = local.present
      ? yield* LibraryState.makeEffect(aliasDevice(local.state, aliases))
      : emptyLibraryState();
    // Every local publish replaces exactly the state this sync planned from.
    const planned = local.present ? local.state : device;
    const imports = {
      skills: aliases.skills.map((alias) => alias.to),
      collections: aliases.collections.map((alias) => alias.to),
    };
    const preliminary = mergeLibraryManifests(
      alignedBase,
      aligned,
      remoteManifest,
      new Set(),
      imports.skills,
      imports.collections,
    );
    // A `--take-remote` key must name a conflict this merge can take remotely, on every path and
    // before any device check; a push, pull or clean sync has none.
    const requested = new Set(options.takeRemote ?? []);
    const availableResolutions = describeLibraryMergeConflicts(
      preliminary.conflicts,
      preliminary.manifest,
      preliminary.unresolvable,
    );
    if (
      [...requested].some(
        (key) =>
          !availableResolutions.some(
            (detail) => detail.key === key && detail.resolution === "take-remote",
          ),
      )
    )
      return { status: "resolution_invalid" as const, ...revision };
    const merged =
      requested.size === 0
        ? preliminary
        : mergeLibraryManifests(
            alignedBase,
            aligned,
            remoteManifest,
            requested,
            imports.skills,
            imports.collections,
          );
    if (merged.conflicts.length)
      return conflicted(
        describeLibraryMergeConflicts(merged.conflicts, merged.manifest, merged.unresolvable),
        remote?.revision_id,
      );
    const collision = yield* resolveSyncProjectionCollisionsEffect(
      merged.manifest,
      options.projection?.rootFor,
      options.keepEnabled,
      device,
    );
    if (collision.invalid) return { status: "resolution_invalid" as const, ...revision };
    if (collision.conflicts.length) return conflicted(collision.conflicts, remote?.revision_id);
    const desired = collision.manifest;
    // An empty device holds no Projections or repository Bindings to plan. Planning it anyway
    // would only report remote Bindings without a selected Version, which a pull accepts.
    const devicePlan = local.present
      ? yield* planSyncProjectionsEffect(planned, device, desired, options.projection?.rootFor)
      : undefined;
    if (devicePlan?.conflicts.length) return conflicted(devicePlan.conflicts, remote?.revision_id);

    if (clean) {
      // Nothing to transfer, write or retire. Publish only to anchor ancestry this state lacks,
      // and only onto the state compared with R.
      if (options.apply) {
        const sync_ancestry = ancestryAt(remote, remoteManifest);
        if (canonicalJson(local.state.sync_ancestry ?? null) !== canonicalJson(sync_ancestry))
          yield* store
            .publish({ ...device, sync_ancestry }, planned)
            .pipe(Effect.catchTag("LibraryChanged", () => Effect.fail(new SyncLocalChanged())));
        yield* progress("Checking enabled Skills");
      }
      const projections = options.apply
        ? projectionCounts(
            yield* reconcileLibraryProjections({
              ...projectionOptions,
              desiredGlobalBindings: remoteManifest.bindings,
              includeRepositoryBindings: true,
            }),
          )
        : { projected: 0, retired: 0 };
      return {
        status: "clean" as const,
        changed: false,
        revision_id: remote.revision_id,
        ...projections,
      };
    }

    // Equivalent handle alignment alone is not a Collection content or evidence change.
    const plan = planLibrarySync(aligned, remoteManifest, desired);
    const required = [...new Set(desired.retained_copies.map((tree) => tree.digest))];
    const snapshotSet = new Set(desired.snapshot_digests);
    const localArchiveByDigest = new Map(localArchives.map((archive) => [archive.digest, archive]));
    const downloads = required.filter(
      (digest) => !localArchiveByDigest.has(digest) && snapshotSet.has(digest),
    );
    const uploads = [...localArchiveByDigest.values()].filter(
      (archive) =>
        required.includes(archive.digest) &&
        snapshotSet.has(archive.digest) &&
        !remoteManifest.snapshot_digests.includes(archive.digest),
    );
    const snapshots = remote === null ? uploads.length : downloads.length;
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
            // Nothing is written until every archive arrives, so a failed download aborts cleanly.
            { concurrency: 4 },
          );
    yield* progress("Restoring retained Skill copies");
    const archives = yield* completeRestoreArchivesEffect(
      desired,
      [...localArchiveByDigest.values(), ...downloaded],
      (digest) => reacquireSourceArchiveEffect(desired, digest, options),
    );
    const restored = yield* Effect.scoped(
      prepareRestoreEffect(desired, archives, store.originalsPath),
    );
    // A merge or pull rechecks L before the remote write; a push relies on the publish check.
    if (remote !== null) {
      const fresh = yield* store.inspect;
      if (
        fresh.present !== local.present ||
        (fresh.present && !same(yield* libraryManifestFromLocalStateEffect(fresh.state), manifest))
      )
        return yield* new SyncLocalChanged();
    }
    for (const [index, archive] of uploads.entries()) {
      yield* progress(`Uploading Skill copies · ${index}/${uploads.length}`);
      yield* api.upload(archive);
      yield* progress(`Uploading Skill copies · ${index + 1}/${uploads.length}`);
    }
    yield* progress("Saving Library sync");
    const saved =
      remote !== null && same(desired, remoteManifest)
        ? remote
        : yield* api.write(remote?.revision_id ?? null, desired);
    // Local state is published only onto exactly what this plan describes. If it moved, the
    // device keeps its old ancestry and the next sync merges both changes.
    const retired = yield* Effect.gen(function* () {
      const retirement =
        devicePlan === undefined
          ? { retired: 0, state: planned }
          : yield* retireSyncProjectionsEffect(devicePlan, projectionOptions.variantsPath, planned);
      const blended = yield* blendRestoredStateEffect(
        { ...device, projections: [...(devicePlan?.projections ?? [])] },
        restored.state,
      );
      yield* store.publish(
        { ...blended, sync_ancestry: ancestryAt(saved, desired) },
        retirement.state,
      );
      return retirement.retired;
    }).pipe(Effect.catchTag("LibraryChanged", () => Effect.fail(new SyncLocalChanged())));
    yield* progress("Enabling synced Skills");
    const projections = projectionCounts(
      yield* reconcileLibraryProjections({
        ...projectionOptions,
        desiredGlobalBindings: desired.bindings,
        includeRepositoryBindings: true,
      }),
    );
    return {
      status:
        remote === null
          ? ("pushed" as const)
          : !local.present
            ? ("pulled" as const)
            : ("merged" as const),
      revision_id: saved.revision_id,
      snapshots,
      ...projections,
      retired: retired + projections.retired,
      plan,
    };
  },
  (effect, options) => (options.apply ? withLibraryWriter(effect) : effect),
);
