import { Effect, Schema } from "effect";
import {
  canonicalJson,
  blendRestoredStateEffect,
  captureSnapshotArchiveEffect,
  completeRestoreArchivesEffect,
  currentLibraryManifest,
  deterministicTreeHashEffect,
  LibraryStore,
  libraryManifestFromLocalStateEffect,
  prepareRestoreEffect,
  prepareObservedCollectionEffect,
  acquisitionIsSourceRestorable,
  resolveSkitSourceEffect,
  retainedTreePath,
  type Acquisition,
  type LibraryManifest,
  type LibraryState,
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
import {
  alignLibraryVersionIds,
  applyLibraryVersionAliases,
  applyDeviceVersionAliases,
} from "./library-version-alignment.js";
import {
  alignLibraryIdentitiesEffect,
  applyDeviceIdentityAliasesEffect,
} from "./library-identity-alignment.js";
import {
  planSyncProjectionsEffect,
  resolveSyncProjectionCollisionsEffect,
  retireSyncProjectionsEffect,
} from "./library-sync-projections.js";
import { SyncConflictDetail } from "./library-sync-contract.js";

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
export class SyncLocalChanged extends Schema.TaggedError<SyncLocalChanged>()(
  "Library.SyncLocalChanged",
  {},
) {}
export class SyncSourceRestoreInvalid extends Schema.TaggedError<SyncSourceRestoreInvalid>()(
  "Library.SyncSourceRestoreInvalid",
  { digest: Schema.String, detail: Schema.String },
) {}

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
      if (gitSource && acquisition.revision === undefined)
        return yield* new SyncSourceRestoreInvalid({
          digest,
          detail: "pinned Git acquisition has no commit",
        });
      let git: { commit: string; tracking_ref: string | null } | undefined;
      if (gitSource) {
        const commit = acquisition.revision;
        if (commit === undefined)
          return yield* new SyncSourceRestoreInvalid({
            digest,
            detail: "pinned Git acquisition has no commit",
          });
        git = { commit, tracking_ref: null };
      }
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
        ...(git === undefined ? {} : { git, requireGitRevision: true }),
        verbatimOnly: true,
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
    const snapshots: SnapshotArchive[] = [];
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
        if (
          manifest.snapshot_digests.includes(archive.digest) &&
          !snapshots.some((candidate) => candidate.digest === archive.digest)
        )
          snapshots.push(archive);
        verified++;
      }
    }
    yield* progress("Reading remote Library");
    const remote = yield* api.read();
    yield* progress("Planning Library sync");
    const downloadArchives = (digests: readonly string[], libraryId: string) =>
      Effect.gen(function* () {
        let completed = 0;
        if (digests.length) yield* progress(`Downloading Skill copies · 0/${digests.length}`);
        return yield* Effect.forEach(
          digests,
          (digest) =>
            api
              .download(libraryId, digest)
              .pipe(
                Effect.tap(() =>
                  progress(`Downloading Skill copies · ${++completed}/${digests.length}`),
                ),
              ),
          // Nothing is written until every archive arrives, so a failed download aborts cleanly.
          { concurrency: 4 },
        );
      });
    const uploadArchives = (archives: readonly SnapshotArchive[]) =>
      Effect.gen(function* () {
        for (const [index, archive] of archives.entries()) {
          yield* progress(`Uploading Skill copies · ${index}/${archives.length}`);
          yield* api.upload(archive);
          yield* progress(`Uploading Skill copies · ${index + 1}/${archives.length}`);
        }
      });
    const ancestry = local.present ? local.state.sync_ancestry : undefined;
    const mismatched =
      ancestry !== undefined &&
      (ancestry.origin !== options.origin ||
        remote === null ||
        ancestry.library_id !== remote.library_id);
    // State and the base it was reconciled with are always published together, never apart.
    const anchored = (
      state: LibraryState,
      library_id: string,
      revision_id: string,
      base_manifest: LibraryManifest,
    ): LibraryState => ({
      ...state,
      sync_ancestry: {
        origin: options.origin,
        library_id,
        revision_id,
        base_manifest: normalizeLibraryManifest(base_manifest),
      },
    });
    if (mismatched && !options.adopt)
      return {
        status: "base_mismatch" as const,
        ...(remote === null ? {} : { revision_id: remote.revision_id }),
      };
    // Explicit adoption sets aside ancestry from another Library. Against an empty base the merge
    // can only add records, never infer a deletion.
    const accepted = mismatched ? undefined : ancestry;
    if (remote === null) {
      if (!local.present) return { status: "clean" as const, changed: false };
      const collision = yield* resolveSyncProjectionCollisionsEffect(
        manifest,
        options.projection?.rootFor,
        options.keepEnabled,
        local.state,
      );
      if (collision.invalid || options.takeRemote?.length)
        return { status: "resolution_invalid" as const };
      if (collision.conflicts.length) return conflicted(collision.conflicts);
      const desired = collision.manifest;
      const devicePlan = yield* planSyncProjectionsEffect(
        local.state,
        local.state,
        desired,
        options.projection?.rootFor,
      );
      if (devicePlan.conflicts.length) return conflicted(devicePlan.conflicts);
      const plan = planLibrarySync(manifest, emptyManifest, desired);
      if (!options.apply)
        return { status: "push_ready" as const, snapshots: snapshots.length, plan };
      if (options.onPlan) yield* options.onPlan(plan);
      // The writer lock held for the whole sync keeps `local.state` the state this plan describes.
      yield* uploadArchives(snapshots);
      yield* progress("Saving remote Library");
      const saved = yield* api.write(null, desired);
      const retired = yield* retireSyncProjectionsEffect(
        devicePlan,
        projectionOptions.variantsPath,
      );
      const afterRetirement = yield* store.load;
      const policies = local.state.global_bindings[0]?.invocation_policies;
      yield* store.publish(
        anchored(
          {
            ...afterRetirement,
            global_bindings: desired.bindings.map((binding) => ({
              ...binding,
              ...(policies === undefined ? {} : { invocation_policies: policies }),
            })),
          },
          saved.library_id,
          saved.revision_id,
          desired,
        ),
      );
      yield* progress("Enabling synced Skills");
      const projections = projectionCounts(
        yield* reconcileLibraryProjections({
          ...projectionOptions,
          desiredGlobalBindings: desired.bindings,
          onlyBindings: desired.bindings,
          includeRepositoryBindings: true,
        }),
      );
      return {
        status: "pushed" as const,
        revision_id: saved.revision_id,
        snapshots: snapshots.length,
        ...projections,
        retired: retired + projections.retired,
        plan,
      };
    }
    const remoteManifest = remote.manifest;
    if (!local.present) {
      const collision = yield* resolveSyncProjectionCollisionsEffect(
        remoteManifest,
        options.projection?.rootFor,
        options.keepEnabled,
      );
      if (collision.invalid || options.takeRemote?.length)
        return { status: "resolution_invalid" as const, revision_id: remote.revision_id };
      if (collision.conflicts.length) return conflicted(collision.conflicts, remote.revision_id);
      const desired = collision.manifest;
      const required = [...new Set(desired.retained_copies.map((tree) => tree.digest))];
      const plan = planLibrarySync(emptyManifest, remoteManifest, desired);
      if (!options.apply)
        return {
          status: "pull_ready" as const,
          snapshots: remoteManifest.snapshot_digests.length,
          plan,
        };
      if (options.onPlan) yield* options.onPlan(plan);
      const snapshotSet = new Set(remoteManifest.snapshot_digests);
      const downloaded = yield* downloadArchives(
        required.filter((digest) => snapshotSet.has(digest)),
        remote.library_id,
      );
      yield* progress("Restoring retained Skill copies");
      const archives = yield* completeRestoreArchivesEffect(desired, downloaded, (digest) =>
        reacquireSourceArchiveEffect(desired, digest, options),
      );
      const restored = yield* Effect.scoped(
        prepareRestoreEffect(desired, archives, store.originalsPath),
      );
      if ((yield* store.inspect).present) return yield* new SyncLocalChanged();
      const saved = same(desired, remoteManifest)
        ? remote
        : yield* api.write(remote.revision_id, desired);
      yield* progress("Saving this device’s Library");
      yield* store.publish(anchored(restored.state, saved.library_id, saved.revision_id, desired));
      yield* progress("Enabling synced Skills");
      const projections = projectionCounts(
        yield* reconcileLibraryProjections({
          ...projectionOptions,
          desiredGlobalBindings: desired.bindings,
          onlyBindings: desired.bindings,
        }),
      );
      return {
        status: "pulled" as const,
        revision_id: saved.revision_id,
        snapshots: remoteManifest.snapshot_digests.length,
        ...projections,
        plan,
      };
    }
    const equalToRemote = same(manifest, remoteManifest);
    if (equalToRemote && !options.keepEnabled?.length) {
      if (options.takeRemote?.length)
        return { status: "resolution_invalid" as const, revision_id: remote.revision_id };
      const collision = yield* resolveSyncProjectionCollisionsEffect(
        remoteManifest,
        options.projection?.rootFor,
        [],
        local.state,
      );
      if (collision.conflicts.length) return conflicted(collision.conflicts, remote.revision_id);
      const devicePlan = yield* planSyncProjectionsEffect(
        local.state,
        local.state,
        remoteManifest,
        options.projection?.rootFor,
      );
      if (devicePlan.conflicts.length) return conflicted(devicePlan.conflicts, remote.revision_id);
      // As for a push, the writer lock keeps `local.state` the state that equals the remote.
      if (options.apply)
        yield* store.publish(
          anchored(local.state, remote.library_id, remote.revision_id, remoteManifest),
        );
      if (options.apply) yield* progress("Checking enabled Skills");
      const projections = options.apply
        ? projectionCounts(
            yield* reconcileLibraryProjections({
              ...projectionOptions,
              desiredGlobalBindings: remoteManifest.bindings,
              onlyBindings: remoteManifest.bindings,
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
    if (accepted === undefined && !options.adopt && !equalToRemote)
      return { status: "adoption_required" as const, revision_id: remote.revision_id };
    const base = accepted?.base_manifest ?? (equalToRemote ? remoteManifest : emptyManifest);
    const identities = yield* alignLibraryIdentitiesEffect(manifest, remoteManifest, base);
    const aligned = alignLibraryVersionIds(identities.manifest, remoteManifest);
    const alignedBase = applyLibraryVersionAliases(base, aligned.aliases);
    const imports = identities.aliases.skills.map((alias) => alias.to);
    const preliminary = mergeLibraryManifests(
      alignedBase,
      aligned.manifest,
      remoteManifest,
      new Set(),
      imports,
      identities.aliases.collections.map((alias) => alias.to),
    );
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
      return { status: "resolution_invalid" as const, revision_id: remote.revision_id };
    const merged = mergeLibraryManifests(
      alignedBase,
      aligned.manifest,
      remoteManifest,
      requested,
      imports,
      identities.aliases.collections.map((alias) => alias.to),
    );
    if (merged.conflicts.length)
      return conflicted(
        describeLibraryMergeConflicts(merged.conflicts, merged.manifest, merged.unresolvable),
        remote.revision_id,
      );
    const alignedDevice = applyDeviceVersionAliases(
      yield* applyDeviceIdentityAliasesEffect(local.state, identities.aliases),
      aligned.aliases,
    );
    const collision = yield* resolveSyncProjectionCollisionsEffect(
      merged.manifest,
      options.projection?.rootFor,
      options.keepEnabled,
      alignedDevice,
    );
    if (collision.invalid)
      return { status: "resolution_invalid" as const, revision_id: remote.revision_id };
    if (collision.conflicts.length) return conflicted(collision.conflicts, remote.revision_id);
    merged.manifest = collision.manifest;
    const devicePlan = yield* planSyncProjectionsEffect(
      local.state,
      alignedDevice,
      merged.manifest,
      options.projection?.rootFor,
    );
    if (devicePlan.conflicts.length) return conflicted(devicePlan.conflicts, remote.revision_id);
    // Equivalent handle alignment alone is not a Collection content or evidence change.
    const plan = planLibrarySync(aligned.manifest, remoteManifest, merged.manifest);
    const required = [...new Set(merged.manifest.retained_copies.map((tree) => tree.digest))];
    const localArchiveByDigest = new Map(localArchives.map((archive) => [archive.digest, archive]));
    const missing = required.filter((digest) => !localArchiveByDigest.has(digest));
    const snapshotSet = new Set(merged.manifest.snapshot_digests);
    const missingSnapshots = missing.filter((digest) => snapshotSet.has(digest));
    if (!options.apply)
      return {
        status: accepted === undefined ? ("adoption_ready" as const) : ("merge_ready" as const),
        revision_id: remote.revision_id,
        snapshots: missingSnapshots.length,
        collections_to_remove: local.state.collections.filter(
          (collection) =>
            !merged.manifest.collections.some(
              (candidate) => candidate.collection_id === collection.collection_id,
            ),
        ).length,
        plan,
      };
    if (options.onPlan) yield* options.onPlan(plan);
    const downloaded = yield* downloadArchives(
      missing.filter((digest) => snapshotSet.has(digest)),
      remote.library_id,
    );
    yield* progress("Restoring retained Skill copies");
    const archives = yield* completeRestoreArchivesEffect(
      merged.manifest,
      [...localArchiveByDigest.values(), ...downloaded],
      (digest) => reacquireSourceArchiveEffect(merged.manifest, digest, options),
    );
    const restored = yield* Effect.scoped(
      prepareRestoreEffect(merged.manifest, archives, store.originalsPath),
    );
    const fresh = yield* store.inspect;
    if (!fresh.present || !same(yield* libraryManifestFromLocalStateEffect(fresh.state), manifest))
      return yield* new SyncLocalChanged();
    yield* uploadArchives(
      [...localArchiveByDigest.values()].filter(
        (archive) =>
          required.includes(archive.digest) &&
          merged.manifest.snapshot_digests.includes(archive.digest) &&
          !remoteManifest.snapshot_digests.includes(archive.digest),
      ),
    );
    yield* progress("Saving Library sync");
    const saved = same(merged.manifest, remoteManifest)
      ? remote
      : yield* api.write(remote.revision_id, merged.manifest);
    const retiredBeforeMerge = yield* retireSyncProjectionsEffect(
      devicePlan,
      projectionOptions.variantsPath,
    );
    const afterRetirement = yield* store.inspect;
    if (!afterRetirement.present) return yield* new SyncLocalChanged();
    const blended = yield* blendRestoredStateEffect(
      {
        ...applyDeviceVersionAliases(
          yield* applyDeviceIdentityAliasesEffect(afterRetirement.state, identities.aliases),
          aligned.aliases,
        ),
        projections: [...devicePlan.projections],
      },
      restored.state,
    );
    yield* store.publish(anchored(blended, saved.library_id, saved.revision_id, merged.manifest));
    yield* progress("Enabling synced Skills");
    const projections = projectionCounts(
      yield* reconcileLibraryProjections({
        ...projectionOptions,
        desiredGlobalBindings: merged.manifest.bindings,
        onlyBindings: merged.manifest.bindings,
        includeRepositoryBindings: true,
      }),
    );
    return {
      status: "merged" as const,
      revision_id: saved.revision_id,
      snapshots: missingSnapshots.length,
      ...projections,
      retired: retiredBeforeMerge + projections.retired,
      plan,
    };
  },
  Effect.catchTag("Library.LibraryRemoteUnsupported", ({ revision_id }) =>
    Effect.succeed({ status: "legacy_remote_conflict" as const, revision_id }),
  ),
);
