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
  type LibraryManifest,
  type SnapshotArchive,
} from "@smolai/skit-core";
import { join } from "node:path";
import { librarySyncApiEffect } from "./library-sync-api.js";
import { mergeLibraryManifests, normalizeLibraryManifest } from "./library-merge.js";
import { publishAcceptedBaseEffect, readAcceptedBaseEffect } from "./library-sync-state.js";
import { reconcileLibraryProjections } from "./projection-reconciliation.js";
import { planLibrarySync, type SyncPlan } from "./library-sync-plan.js";

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
export const deferredLibraryBindings = (
  manifest: LibraryManifest,
  rootFor: (harness: LibraryManifest["bindings"][number]["harness"]) => string | undefined,
) =>
  manifest.bindings.flatMap((binding) => {
    if (rootFor(binding.harness) !== undefined) return [];
    const skills = binding.skills.flatMap((skillId) => {
      const skill = manifest.skills.find((candidate) => candidate.skill_id === skillId);
      return skill === undefined ? [] : [skill.name];
    });
    return [
      {
        harness: binding.harness,
        skills,
      },
    ];
  });

const projectionCounts = (
  result: { readonly projected: number; readonly deferred: number; readonly retired: number },
  manifest: LibraryManifest,
  rootFor: (harness: LibraryManifest["bindings"][number]["harness"]) => string | undefined,
) => ({
  projected: result.projected,
  deferred: result.deferred,
  retired: result.retired,
  deferred_bindings: deferredLibraryBindings(manifest, rootFor),
});
export class SyncLocalChanged extends Schema.TaggedError<SyncLocalChanged>()(
  "Library.SyncLocalChanged",
  {},
) {}
export class SyncSourceRestoreInvalid extends Schema.TaggedError<SyncSourceRestoreInvalid>()(
  "Library.SyncSourceRestoreInvalid",
  { digest: Schema.String, detail: Schema.String },
) {}

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
      if (gitSource && acquisition.source_revision === undefined)
        return yield* new SyncSourceRestoreInvalid({
          digest,
          detail: "pinned Git acquisition has no commit",
        });
      let git: { commit: string; tracking_ref: string | null } | undefined;
      if (gitSource) {
        const commit = acquisition.source_revision;
        if (commit === undefined)
          return yield* new SyncSourceRestoreInvalid({
            digest,
            detail: "pinned Git acquisition has no commit",
          });
        git = { commit, tracking_ref: null };
      }
      const resolved = yield* resolveSkitSourceEffect(acquisition.input.value, {
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

export const syncLibraryEffect = Effect.fn("Library.sync")(function* (options: {
  origin: string;
  token?: string;
  apply: boolean;
  adopt?: boolean;
  takeRemote?: readonly string[];
  projection?: {
    variantsPath: string;
    rootFor: (harness: LibraryManifest["bindings"][number]["harness"]) => string | undefined;
  };
  onPlan?: (plan: SyncPlan) => Effect.Effect<void>;
}) {
  const store = yield* LibraryStore;
  const projectionOptions = {
    home: store.home,
    variantsPath: options.projection?.variantsPath ?? store.originalsPath,
    rootFor: (harness: LibraryManifest["bindings"][number]["harness"]) =>
      options.projection?.rootFor(harness),
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
  if (remote?.manifest.schema === "skit.library.v2")
    return { status: "legacy_remote_conflict" as const, revision_id: remote.revision_id };
  const accepted = yield* readAcceptedBaseEffect(store.home);
  const remember = Effect.fn("Library.sync.remember")(function* (
    library_id: string,
    revision_id: string,
    base_manifest: LibraryManifest,
  ) {
    yield* publishAcceptedBaseEffect(store.home, {
      schemaVersion: 1,
      origin: options.origin,
      library_id,
      revision_id,
      base_manifest: normalizeLibraryManifest(base_manifest),
    });
  });
  if (
    accepted !== undefined &&
    (accepted.origin !== options.origin ||
      remote === null ||
      accepted.library_id !== remote.library_id)
  )
    return {
      status: "base_mismatch" as const,
      ...(remote === null ? {} : { revision_id: remote.revision_id }),
    };
  if (remote === null && !local.present) return { status: "clean" as const, changed: false };
  if (remote === null) {
    const plan = planLibrarySync(manifest, emptyManifest, manifest);
    if (!options.apply) return { status: "push_ready" as const, snapshots: snapshots.length, plan };
    if (options.onPlan) yield* options.onPlan(plan);
    for (const archive of snapshots) yield* api.upload(archive);
    const saved = yield* api.write(null, manifest);
    yield* remember(saved.library_id, saved.revision_id, manifest);
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
    const deferredBindings = deferredLibraryBindings(remoteManifest, projectionOptions.rootFor);
    if (!options.apply)
      return {
        status: "pull_ready" as const,
        snapshots: remoteManifest.snapshot_digests.length,
        plan,
        deferred: deferredBindings.length,
        deferred_bindings: deferredBindings,
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
    yield* store.publish(restored.state);
    yield* remember(remote.library_id, remote.revision_id, remoteManifest);
    const projections = projectionCounts(
      yield* reconcileLibraryProjections({
        ...projectionOptions,
        desiredGlobalBindings: remoteManifest.bindings,
        onlyBindings: remoteManifest.bindings,
      }),
      remoteManifest,
      projectionOptions.rootFor,
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
    if (options.apply) yield* remember(remote.library_id, remote.revision_id, remoteManifest);
    const projections = options.apply
      ? projectionCounts(
          yield* reconcileLibraryProjections({
            ...projectionOptions,
            desiredGlobalBindings: remoteManifest.bindings,
            onlyBindings: remoteManifest.bindings,
          }),
          remoteManifest,
          projectionOptions.rootFor,
        )
      : { projected: 0, deferred: 0, retired: 0, deferred_bindings: [] };
    return {
      status: "clean" as const,
      changed: false,
      revision_id: remote.revision_id,
      ...projections,
    };
  }
  if (accepted === undefined && !options.adopt)
    return { status: "adoption_required" as const, revision_id: remote.revision_id };
  const preliminary = mergeLibraryManifests(
    accepted?.base_manifest ?? emptyManifest,
    manifest,
    remoteManifest,
  );
  const requested = new Set(options.takeRemote ?? []);
  if ([...requested].some((key) => !preliminary.conflicts.some((conflict) => conflict === key)))
    return { status: "resolution_invalid" as const, revision_id: remote.revision_id };
  const merged = mergeLibraryManifests(
    accepted?.base_manifest ?? emptyManifest,
    manifest,
    remoteManifest,
    requested,
  );
  const custody = restoreCustodyConflicts(local.state, merged.manifest);
  const conflicts = [...new Set([...merged.conflicts, ...custody])].sort();
  if (conflicts.length > 0)
    return { status: "conflicted" as const, revision_id: remote.revision_id, conflicts };
  const plan = planLibrarySync(manifest, remoteManifest, merged.manifest);
  const deferredBindings = deferredLibraryBindings(merged.manifest, projectionOptions.rootFor);
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
      deferred: deferredBindings.length,
      deferred_bindings: deferredBindings,
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
  const blended = yield* blendRestoredStateEffect(afterRetirement.state, restored.state);
  yield* store.publish(blended);
  yield* remember(saved.library_id, saved.revision_id, merged.manifest);
  const projections = projectionCounts(
    yield* reconcileLibraryProjections({
      ...projectionOptions,
      desiredGlobalBindings: merged.manifest.bindings,
      onlyBindings: merged.manifest.bindings,
    }),
    merged.manifest,
    projectionOptions.rootFor,
  );
  return {
    status: "merged" as const,
    revision_id: saved.revision_id,
    snapshots: missingSnapshots.length,
    ...projections,
    retired: retiredBeforeMerge.retired + projections.retired,
    plan,
  };
});
