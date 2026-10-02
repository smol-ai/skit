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
  restoreCustodyConflicts,
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
import { mergeLibraryManifests, normalizeLibraryManifest } from "./library-merge.js";
import { reconcileLibraryProjections } from "./projection-reconciliation.js";
import { planLibrarySync, type SyncPlan } from "./library-sync-plan.js";
import {
  alignLibraryVersionIds,
  applyLibraryVersionAliases,
  applyDeviceVersionAliases,
} from "./library-version-alignment.js";

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
      const resolved = yield* resolveSkitSourceEffect(source, {
        registryBaseUrl: options.origin,
        ...(options.token === undefined ? {} : { registryToken: options.token }),
        ...(git === undefined ? {} : { git, requireGitRevision: true }),
        verbatimOnly: true,
      });
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
      detail: `source returned ${archive.digest}`,
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
    projection?: {
      variantsPath: string;
      rootFor: (target: ProjectionTarget) => string | undefined;
    };
    onPlan?: (plan: SyncPlan) => Effect.Effect<void>;
  }) {
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
      for (const tree of local.state.retained_copies) {
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
      }
    }
    const remote = yield* api.read();
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
      const plan = planLibrarySync(manifest, emptyManifest, manifest);
      if (!options.apply)
        return { status: "push_ready" as const, snapshots: snapshots.length, plan };
      if (options.onPlan) yield* options.onPlan(plan);
      // The writer lock held for the whole sync keeps `local.state` the state this plan describes.
      for (const archive of snapshots) yield* api.upload(archive);
      const saved = yield* api.write(null, manifest);
      yield* store.publish(anchored(local.state, saved.library_id, saved.revision_id, manifest));
      return {
        status: "pushed" as const,
        revision_id: saved.revision_id,
        snapshots: snapshots.length,
        plan,
      };
    }
    const remoteManifest = remote.manifest;
    if (!local.present) {
      const required = [...new Set(remoteManifest.retained_copies.map((tree) => tree.digest))];
      const plan = planLibrarySync(emptyManifest, remoteManifest, remoteManifest);
      if (!options.apply)
        return {
          status: "pull_ready" as const,
          snapshots: remoteManifest.snapshot_digests.length,
          plan,
        };
      if (options.onPlan) yield* options.onPlan(plan);
      const snapshotSet = new Set(remoteManifest.snapshot_digests);
      const downloaded = yield* Effect.forEach(
        required.filter((digest) => snapshotSet.has(digest)),
        (digest) => api.download(remote.library_id, digest),
      );
      const archives = yield* completeRestoreArchivesEffect(remoteManifest, downloaded, (digest) =>
        reacquireSourceArchiveEffect(remoteManifest, digest, options),
      );
      const restored = yield* Effect.scoped(
        prepareRestoreEffect(remoteManifest, archives, store.originalsPath),
      );
      if ((yield* store.inspect).present) return yield* new SyncLocalChanged();
      yield* store.publish(
        anchored(restored.state, remote.library_id, remote.revision_id, remoteManifest),
      );
      const projections = projectionCounts(
        yield* reconcileLibraryProjections({
          ...projectionOptions,
          desiredGlobalBindings: remoteManifest.bindings,
          onlyBindings: remoteManifest.bindings,
        }),
      );
      return {
        status: "pulled" as const,
        revision_id: remote.revision_id,
        snapshots: remoteManifest.snapshot_digests.length,
        ...projections,
        plan,
      };
    }
    if (same(manifest, remoteManifest)) {
      // As for a push, the writer lock keeps `local.state` the state that equals the remote.
      if (options.apply)
        yield* store.publish(
          anchored(local.state, remote.library_id, remote.revision_id, remoteManifest),
        );
      const projections = options.apply
        ? projectionCounts(
            yield* reconcileLibraryProjections({
              ...projectionOptions,
              desiredGlobalBindings: remoteManifest.bindings,
              onlyBindings: remoteManifest.bindings,
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
    if (accepted === undefined && !options.adopt)
      return { status: "adoption_required" as const, revision_id: remote.revision_id };
    const aligned = alignLibraryVersionIds(manifest, remoteManifest);
    const alignedBase = applyLibraryVersionAliases(
      accepted?.base_manifest ?? emptyManifest,
      aligned.aliases,
    );
    const preliminary = mergeLibraryManifests(alignedBase, aligned.manifest, remoteManifest);
    const requested = new Set(options.takeRemote ?? []);
    if ([...requested].some((key) => !preliminary.conflicts.some((conflict) => conflict === key)))
      return { status: "resolution_invalid" as const, revision_id: remote.revision_id };
    const merged = mergeLibraryManifests(alignedBase, aligned.manifest, remoteManifest, requested);
    const custody = restoreCustodyConflicts(
      applyDeviceVersionAliases(local.state, aligned.aliases),
      merged.manifest,
    );
    const conflicts = [...new Set([...merged.conflicts, ...custody])].sort();
    if (conflicts.length > 0)
      return { status: "conflicted" as const, revision_id: remote.revision_id, conflicts };
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
    const downloaded = yield* Effect.forEach(
      missing.filter((digest) => snapshotSet.has(digest)),
      (digest) => api.download(remote.library_id, digest),
    );
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
    for (const archive of snapshots)
      if (
        required.includes(archive.digest) &&
        merged.manifest.snapshot_digests.includes(archive.digest) &&
        !remoteManifest.snapshot_digests.includes(archive.digest)
      )
        yield* api.upload(archive);
    const saved = same(merged.manifest, remoteManifest)
      ? remote
      : yield* api.write(remote.revision_id, merged.manifest);
    const retiredBeforeMerge = yield* reconcileLibraryProjections({
      ...projectionOptions,
      desiredGlobalBindings: merged.manifest.bindings,
      retireOnly: true,
    });
    const afterRetirement = yield* store.inspect;
    if (!afterRetirement.present) return yield* new SyncLocalChanged();
    const blended = yield* blendRestoredStateEffect(
      applyDeviceVersionAliases(afterRetirement.state, aligned.aliases),
      restored.state,
    );
    yield* store.publish(anchored(blended, saved.library_id, saved.revision_id, merged.manifest));
    const projections = projectionCounts(
      yield* reconcileLibraryProjections({
        ...projectionOptions,
        desiredGlobalBindings: merged.manifest.bindings,
        onlyBindings: merged.manifest.bindings,
      }),
    );
    return {
      status: "merged" as const,
      revision_id: saved.revision_id,
      snapshots: missingSnapshots.length,
      ...projections,
      retired: retiredBeforeMerge.retired + projections.retired,
      plan,
    };
  },
  Effect.catchTag("Library.LibraryRemoteUnsupported", ({ revision_id }) =>
    Effect.succeed({ status: "legacy_remote_conflict" as const, revision_id }),
  ),
);
