import { SourceRestoreInvalid } from "../../source-restore-failures.js";
export { SourceRestoreInvalid } from "../../source-restore-failures.js";
import type { CollectionVersionPlan } from "../../collection-version-plan.js";
import type { RestoreProgress, RestorePhase } from "../../restore-progress.js";
import type { Hash } from "../../../shared/hash.js";
import { ContentAddressCollision } from "../../failures.js";
import { collectionVersionPath, originalTreeHash } from "../../collection-version.js";
import { resolveSkitSource } from "../../../sources/resolve.js";
import { deterministicTreeHash } from "../../../artifact/skit.js";
import { prepareImport } from "../../import-collection.js";
import { Effect, FileSystem, Schema } from "effect";
import { join } from "node:path";

import { writeCollectionVersion } from "./collection-version.js";
import { readSnapshotArchive, writeVerifiedSnapshot } from "../../snapshot-archive.js";
import { verifySnapshotArchive } from "../../snapshot-archive-universal.js";
import { currentLibraryState, LibraryState } from "../../library-state.js";
import {
  importCanBeRefetched,
  type Import,
  type SkitSource,
  enabledSkillIds,
  currentLibraryManifest,
  librarySnapshotDigests,
  type LibraryManifest,
  type SnapshotArchive,
} from "../../library-contracts.js";
import { repositorySelectsInstalledSkill } from "../../installation/uninstall.js";
import {
  RestoreInvalid,
  type RestoreInvalidReason,
  type RestoreOwnershipConflict,
} from "../../restore-failures.js";
export { RestoreInvalid } from "../../restore-failures.js";

/** Access to historical sources and the destination for verified retained bytes. */
export interface RestoreOptions {
  readonly originalsPath: string;
  readonly registryBaseUrl?: string;
  readonly registryToken?: string;
  readonly progress?: RestoreProgress;
}

/**
 * The Source to refetch an import's exact bytes from: its recorded identity at its
 * revision. Git restores pin the commit separately; a Registry restore names the Release.
 */
const restorableSource = (
  sourceImport: Import,
): { source: SkitSource; commit: string | undefined } | undefined => {
  if (!importCanBeRefetched(sourceImport)) return undefined;
  const identity = sourceImport.source_identity;
  const subpath =
    (identity.kind === "github" || identity.kind === "git") && identity.collection_root !== "."
      ? { subpath: identity.collection_root }
      : {};
  switch (identity.kind) {
    case "github":
      return {
        source: {
          type: "github",
          owner: identity.owner,
          repository: identity.repository,
          ...subpath,
        },
        commit: sourceImport.revision,
      };
    case "git":
      return {
        source: { type: "git", remote: identity.remote.value, ...subpath },
        commit: sourceImport.revision,
      };
    case "registry":
      return {
        source: {
          type: "registry",
          namespace: identity.namespace,
          slug: identity.slug,
          version: sourceImport.revision,
          ...(identity.authority === "default" ? {} : { authority: identity.authority }),
        },
        commit: undefined,
      };
  }
};

const refetchSourceArchive = Effect.fn("Library.restore.refetchSource")(function* (
  manifest: LibraryManifest,
  hash: string,
  options: RestoreOptions,
) {
  const copy = manifest.collection_versions.find((candidate) => candidate.hash === hash);
  const source = manifest.imports
    .filter((candidate) => candidate.collection_version_id === copy?.collection_version_id)
    .map(restorableSource)
    .find((candidate) => candidate !== undefined);
  if (copy === undefined || source === undefined)
    return yield* new SourceRestoreInvalid({
      hash,
      reason: { _tag: "SourceImportMissing" },
    });
  const archive = yield* Effect.scoped(
    Effect.gen(function* () {
      const profiles = new Set(copy.members.map((member) => member.materialization_profile));
      if (profiles.size !== 1)
        return yield* new SourceRestoreInvalid({
          hash,
          reason: { _tag: "NormalizationProfiles", profiles: [...profiles] },
        });
      const resolved = yield* resolveSkitSource(source.source, {
        registryBaseUrl: options.registryBaseUrl,
        ...(options.registryToken === undefined ? {} : { registryToken: options.registryToken }),
        ...(source.commit === undefined
          ? {}
          : { git: { commit: source.commit, tracking_ref: null }, requireGitRevision: true }),
      });
      // Declared imports retain the whole resolved SKIT root, including shared and non-Skill files.
      if (profiles.has("declared-skit-skill/v1")) {
        if (resolved.descriptorKind !== "declared")
          return yield* new SourceRestoreInvalid({
            hash,
            reason: { _tag: "DescriptorMissing" },
          });
        return yield* readSnapshotArchive(resolved.root);
      }
      const prepared = yield* prepareImport(
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
              currentHash: yield* deterministicTreeHash(sourcePath),
            };
          }),
        ),
      );
      return yield* readSnapshotArchive(prepared.staged);
    }),
  ).pipe(
    Effect.mapError((cause) =>
      cause._tag === "Library.SyncSourceRestoreInvalid"
        ? cause
        : new SourceRestoreInvalid({ hash, reason: { _tag: "SourceFetchFailed", failure: cause } }),
    ),
  );
  if (archive.digest !== hash)
    return yield* new SourceRestoreInvalid({
      hash,
      reason: { _tag: "HashMismatch", actual: archive.digest },
    });
  return archive;
});

const silentRestoreProgress: RestoreProgress = {
  around: (_phase, operation) => operation,
  tick: () => Effect.void,
};

/** Reject incomplete or foreign plans before any I/O. Their bytes still need verifying. */
export const restorePlanProblem = (
  manifest: LibraryManifest,
  plan: CollectionVersionPlan,
): RestoreInvalidReason | undefined => {
  const required = new Set(manifest.collection_versions.map((copy) => copy.hash));
  const copies = new Map(
    manifest.collection_versions.map((copy) => [copy.collection_version_id, copy]),
  );
  const snapshots = new Set(manifest.snapshot_digests);
  const covered = new Set<Hash>();
  for (const hash of [
    ...plan.localArchives.map((archive) => archive.digest),
    ...plan.reusable,
    ...plan.download,
  ]) {
    if (!required.has(hash)) return { _tag: "ForeignCopy", hash };
    covered.add(hash);
  }
  for (const hash of plan.download) {
    if (!snapshots.has(hash)) return { _tag: "DownloadForSourceCopy", hash };
  }
  for (const id of plan.reacquire) {
    const copy = copies.get(id);
    if (copy === undefined) return { _tag: "UnknownCopy", id };
    if (snapshots.has(copy.hash)) return { _tag: "SourceRestoreUnavailable", hash: copy.hash };
    covered.add(copy.hash);
  }
  for (const hash of required) {
    if (!covered.has(hash)) return { _tag: "CopyNotAvailable", hash };
  }
};

/** Resolve every required byte before writing any new immutable object. */
export const completeRestoreArchives = Effect.fn("Library.completeRestoreArchives")(function* <
  E = never,
  R = never,
>(
  manifest: LibraryManifest,
  plan: CollectionVersionPlan,
  options: RestoreOptions & {
    readonly download?: (hash: Hash) => Effect.Effect<SnapshotArchive, E, R>;
  },
) {
  const invalid = restorePlanProblem(manifest, plan);
  if (invalid !== undefined) return yield* new RestoreInvalid({ reason: invalid });
  if (plan.download.length && options.download === undefined)
    return yield* new RestoreInvalid({
      reason: { _tag: "DownloadTransportMissing", hashes: plan.download },
    });
  const progress = options.progress ?? silentRestoreProgress;
  const archives = new Map(plan.localArchives.map((archive) => [archive.digest, archive]));
  const fs = yield* FileSystem.FileSystem;
  const existingPaths = new Map<string, string>();
  if (plan.reusable.length) {
    const phase = { kind: "verify-local", total: plan.reusable.length } as const;
    yield* progress.around(
      phase,
      Effect.gen(function* () {
        for (const [index, hash] of plan.reusable.entries()) {
          const path = collectionVersionPath(options.originalsPath, hash);
          const copy = manifest.collection_versions.find((candidate) => candidate.hash === hash);
          const subject =
            manifest.imports.find(
              (candidate) => candidate.collection_version_id === copy?.collection_version_id,
            )?.input.value ?? hash;
          yield* progress.tick({ phase, completed: index, subject });
          // Replan on retry rather than silently adding an unplanned transfer.
          if (!(yield* fs.exists(path)))
            return yield* new RestoreInvalid({
              reason: { _tag: "ReusableCopyMissing", hash, path },
            });
          if ((yield* originalTreeHash(path)) !== hash) return yield* new ContentAddressCollision();
          existingPaths.set(hash, path);
          yield* progress.tick({ phase, completed: index + 1, subject });
        }
      }),
    );
  }
  if (plan.download.length) {
    const phase = { kind: "download", total: plan.download.length } as const;
    let completed = 0;
    const downloaded = yield* progress.around(
      phase,
      Effect.gen(function* () {
        yield* progress.tick({ phase, completed: 0 });
        return yield* Effect.forEach(
          plan.download,
          (hash) =>
            Effect.gen(function* () {
              if (options.download === undefined)
                return yield* new RestoreInvalid({
                  reason: { _tag: "DownloadTransportMissing", hashes: [hash] },
                });
              const archive = yield* options.download(hash);
              if (archive.digest !== hash)
                return yield* new RestoreInvalid({
                  reason: { _tag: "DownloadHashMismatch", expected: hash, actual: archive.digest },
                });
              yield* progress.tick({ phase, completed: ++completed });
              return archive;
            }),
          { concurrency: 4 },
        );
      }),
    );
    for (const archive of downloaded) archives.set(archive.digest, archive);
  }
  for (const id of plan.reacquire) {
    const copy = manifest.collection_versions.find(
      (candidate) => candidate.collection_version_id === id,
    );
    if (copy === undefined)
      return yield* new RestoreInvalid({ reason: { _tag: "UnknownCopy", id } });
    // A stale or mismatched plan must never turn private content into a source fetch.
    if (manifest.snapshot_digests.includes(copy.hash))
      return yield* new RestoreInvalid({
        reason: { _tag: "SourceRestoreUnavailable", hash: copy.hash },
      });
    const subject =
      manifest.imports.find((candidate) => candidate.collection_version_id === id)?.input.value ??
      copy.hash;
    const archive = yield* progress.around(
      { kind: "fetch-source", subject },
      refetchSourceArchive(manifest, copy.hash, options),
    );
    archives.set(archive.digest, archive);
  }
  // Plans describe observations, not authority to omit required content.
  for (const copy of manifest.collection_versions) {
    if (!archives.has(copy.hash) && !existingPaths.has(copy.hash))
      return yield* new RestoreInvalid({ reason: { _tag: "CopyNotAvailable", hash: copy.hash } });
  }
  return { archives: [...archives.values()], existingPaths };
});

/**
 * Prepare the exact content a manifest requires, without saving Library state or rewriting
 * import history. Available snapshots and exact source reconstruction share verification.
 */
export const restoredState = Effect.fn("Library.restoredState")(function* (
  manifest: LibraryManifest,
) {
  return yield* LibraryState.makeEffect(
    currentLibraryState({
      collections: [...manifest.collections],
      skills: [...manifest.skills],
      collection_versions: [...manifest.collection_versions],
      imports: [...manifest.imports],
      enabled: [...manifest.enabled],
      repositories: [],
      installed_skills: [],
      unmanaged: [],
      operations: [],
    }),
  ).pipe(
    Effect.mapError(
      (issue) =>
        new RestoreInvalid({
          reason: {
            _tag: "StateInvalid",
            stage: "restored-library",
            failure: new Schema.SchemaError(issue),
          },
        }),
    ),
  );
});

/** Publish only previously resolved, verified bytes; the owner supplies its writer around this step. */
export const importRestoreArchives = Effect.fn("Library.importRestoreArchives")(function* (
  manifest: LibraryManifest,
  available: {
    readonly archives: readonly SnapshotArchive[];
    readonly existingPaths: ReadonlyMap<string, string>;
  },
  options: RestoreOptions,
) {
  const progress = options.progress ?? silentRestoreProgress;
  const { archives, existingPaths } = available;
  const received = new Map(archives.map((archive) => [archive.digest, archive]));
  const fs = yield* FileSystem.FileSystem;
  const verifiedPaths = new Map(existingPaths);
  const phase: RestorePhase = { kind: "retain", total: manifest.collection_versions.length };
  if (phase.total)
    yield* progress.around(
      phase,
      Effect.gen(function* () {
        for (const [index, tree] of manifest.collection_versions.entries()) {
          const label =
            manifest.imports.find(
              (candidate) => candidate.collection_version_id === tree.collection_version_id,
            )?.input.value ?? tree.hash;
          yield* progress.tick({ phase, completed: index, subject: label });
          const archive = received.get(tree.hash);
          let path = verifiedPaths.get(tree.hash);
          // Fetching may have taken time outside the writer. Repeat immutable verification
          // before relying on a path resolved earlier, including non-Skill files in the tree.
          if (path !== undefined && (yield* originalTreeHash(path)) !== tree.hash)
            return yield* new ContentAddressCollision();
          if (path === undefined) {
            path = collectionVersionPath(options.originalsPath, tree.hash);
            if (yield* fs.exists(path)) {
              // Existing immutable objects still need verification, but no unpack/copy cycle.
              if ((yield* originalTreeHash(path)) !== tree.hash)
                return yield* new ContentAddressCollision();
            } else {
              if (archive === undefined)
                return yield* new RestoreInvalid({
                  reason: { _tag: "CopyNotAvailable", hash: tree.hash },
                });
              const verified = yield* verifySnapshotArchive(archive);
              path = yield* Effect.scoped(
                Effect.gen(function* () {
                  const temporary = yield* writeVerifiedSnapshot(verified);
                  return yield* writeCollectionVersion(
                    temporary,
                    options.originalsPath,
                    tree.hash,
                    true,
                  );
                }),
              );
            }
            verifiedPaths.set(tree.hash, path);
          }
          for (const member of tree.members) {
            const directory = member.source_path === "." ? path : join(path, member.source_path);
            const actual = yield* originalTreeHash(directory);
            if (actual !== member.source_hash)
              return yield* new RestoreInvalid({
                reason: {
                  _tag: "MemberHashMismatch",
                  path: member.source_path,
                  expected: member.source_hash,
                  actual,
                },
              });
          }
          yield* progress.tick({ phase, completed: index + 1, subject: label });
        }
      }),
    );
  const state = yield* restoredState(manifest);
  return { state };
});

/** Preview device facts that replacement of portable Library state would strand. */
function strandedByRestore(current: LibraryState, manifest: LibraryManifest) {
  const skillIds = new Set(manifest.skills.map((item) => item.skill_id));
  const versionIds = new Set(
    manifest.skills.flatMap((skill) => skill.versions.map((version) => version.skill_version_id)),
  );
  const conflicts: RestoreOwnershipConflict[] = [];
  const enabled = new Set(enabledSkillIds(manifest, manifest.enabled));
  for (const installed of current.installed_skills) {
    if (
      (!enabled.has(installed.skill_id) && !repositorySelectsInstalledSkill(current, installed)) ||
      (skillIds.has(installed.skill_id) && versionIds.has(installed.skill_version_id))
    )
      continue;
    conflicts.push({
      _tag: "InstalledVersionMissing",
      installedSkillId: installed.installed_skill_id,
      skillId: installed.skill_id,
      versionId: installed.skill_version_id,
      path: installed.path,
    });
  }
  for (const repository of current.repositories) {
    for (const selection of repository.enabled) {
      const exists =
        "skill" in selection
          ? manifest.skills.some((skill) => skill.skill_id === selection.skill)
          : manifest.collections.some(
              (collection) => collection.collection_id === selection.collection,
            );
      if (!exists)
        conflicts.push({ _tag: "RepositorySelectionMissing", root: repository.root, selection });
    }
  }
  return conflicts;
}

/** Keep current device ownership while replacing the portable Library fields. */
export const blendRestoredState = Effect.fn("Library.blendRestoredState")(function* (
  current: LibraryState,
  restored: LibraryState,
) {
  const manifest: LibraryManifest = currentLibraryManifest({
    collections: restored.collections,
    skills: restored.skills,
    collection_versions: restored.collection_versions,
    imports: restored.imports,
    snapshot_digests: librarySnapshotDigests(restored),
    enabled: restored.enabled,
  });
  const ownership = strandedByRestore(current, manifest);
  if (ownership.length > 0)
    return yield* new RestoreInvalid({
      reason: { _tag: "OwnershipWouldBeStranded", conflicts: ownership },
    });
  // This device's invocation overrides apply to whatever the restored Library enables.
  const { invocation_policies: localPolicies, ...device } = current;
  return yield* LibraryState.makeEffect({
    ...device,
    collections: restored.collections,
    skills: restored.skills,
    collection_versions: restored.collection_versions,
    imports: restored.imports,
    enabled: restored.enabled,
    ...(localPolicies === undefined || restored.enabled.length === 0
      ? {}
      : { invocation_policies: localPolicies }),
  }).pipe(
    Effect.mapError(
      (issue) =>
        new RestoreInvalid({
          reason: {
            _tag: "StateInvalid",
            stage: "merged-library",
            failure: new Schema.SchemaError(issue),
          },
        }),
    ),
  );
});
