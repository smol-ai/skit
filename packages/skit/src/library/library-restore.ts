import type { CollectionVersionPlan } from "./collection-version-plan.js";
import type { RestoreProgress, RestorePhase } from "./restore-progress.js";
import type { Digest } from "../contracts.js";
import { ContentAddressCollision } from "../failures.js";
import { collectionVersionPath } from "./collection-version.js";
import { resolveSkitSource } from "../sources/resolve.js";
import { deterministicTreeHash } from "../artifact/skit.js";
import { prepareImport } from "./import-collection.js";
import { Data, Effect, FileSystem } from "effect";
import { join } from "node:path";
import { originalTreeHash, writeCollectionVersion } from "./collection-version.js";
import { captureSnapshotArchive, materializeVerifiedSnapshot } from "./snapshot-archive.js";
import { verifySnapshotArchive } from "./snapshot-archive-universal.js";
import { currentLibraryState, LibraryState } from "./library-state.js";
import {
  importCanBeRefetched,
  type Import,
  type SkitSource,
  enabledSkillIds,
  currentLibraryManifest,
  librarySnapshotDigests,
  type LibraryManifest,
  type SnapshotArchive,
} from "./library-contracts.js";
import { repositorySelectsInstalledSkill } from "./installation/uninstall.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

export class RestoreInvalid
  extends Data.TaggedError("Library.RestoreInvalid")<{ detail: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Run `skit doctor` to inspect the Library, then run `skit sync` again.";
  get message(): string {
    return `Cannot restore the Library: ${this.detail}`;
  }
}

/** Access to historical sources and the destination for verified retained bytes. */
export interface RestoreOptions {
  readonly originalsPath: string;
  readonly registryBaseUrl?: string;
  readonly registryToken?: string;
  readonly progress?: RestoreProgress;
}

/** Preserve the existing diagnostic tag as source restoration moves behind the core boundary. */
export class SourceRestoreInvalid
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
 * The Source to refetch an import's exact bytes from: its recorded identity at its
 * revision. Git restores pin the commit separately; a Registry restore names the Release.
 */
const restorableSource = (sourceImport: Import): SkitSource | undefined => {
  const identity = sourceImport.source_identity;
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
      return sourceImport.revision === undefined
        ? undefined
        : {
            type: "registry",
            namespace: identity.namespace,
            slug: identity.slug,
            version: sourceImport.revision,
            ...(identity.authority === "default" ? {} : { authority: identity.authority }),
          };
    default:
      return undefined;
  }
};

const refetchSourceArchive = Effect.fn("Library.restore.refetchSource")(function* (
  manifest: LibraryManifest,
  digest: string,
  options: RestoreOptions,
) {
  const copy = manifest.collection_versions.find((candidate) => candidate.digest === digest);
  const sourceImport = manifest.imports.find(
    (candidate) =>
      candidate.collection_version_id === copy?.collection_version_id &&
      importCanBeRefetched(candidate),
  );
  if (copy === undefined || sourceImport === undefined)
    return yield* new SourceRestoreInvalid({
      digest,
      detail: "manifest has no exact source-restoration acquisition",
    });
  const archive = yield* Effect.scoped(
    Effect.gen(function* () {
      const gitSource =
        sourceImport.source_identity.kind === "github" ||
        sourceImport.source_identity.kind === "git";
      const commit = gitSource ? sourceImport.revision : undefined;
      if (gitSource && commit === undefined)
        return yield* new SourceRestoreInvalid({
          digest,
          detail: "pinned Git acquisition has no commit",
        });
      const source = restorableSource(sourceImport);
      if (source === undefined)
        return yield* new SourceRestoreInvalid({
          digest,
          detail: "acquisition has no restorable source identity",
        });
      const profiles = new Set(copy.members.map((member) => member.materialization_profile));
      if (profiles.size !== 1)
        return yield* new SourceRestoreInvalid({
          digest,
          detail: "retained copy has no single materialization profile",
        });
      const resolved = yield* resolveSkitSource(source, {
        registryBaseUrl: options.registryBaseUrl,
        ...(options.registryToken === undefined ? {} : { registryToken: options.registryToken }),
        ...(commit === undefined
          ? {}
          : { git: { commit, tracking_ref: null }, requireGitRevision: true }),
      });
      // Declared imports retain the whole resolved SKIT root, including shared and non-Skill files.
      if (profiles.has("declared-skit-skill/v1")) {
        if (resolved.descriptorKind !== "declared")
          return yield* new SourceRestoreInvalid({
            digest,
            detail: "declared retained copy source has no declared Descriptor",
          });
        return yield* captureSnapshotArchive(resolved.root);
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
              observedHash: yield* deterministicTreeHash(sourcePath),
            };
          }),
        ),
      );
      return yield* captureSnapshotArchive(prepared.staged);
    }),
  );
  if (archive.digest !== digest)
    return yield* new SourceRestoreInvalid({
      digest,
      detail: `source returned ${archive.digest}; expected ${digest}`,
    });
  return archive;
});

const silentRestoreProgress: RestoreProgress = {
  around: (_phase, operation) => operation,
  tick: () => Effect.void,
};

/** Reject incomplete or foreign plans before any I/O. Their bytes still need verifying. */
const invalidPlan = (
  manifest: LibraryManifest,
  plan: CollectionVersionPlan,
  hasDownload: boolean,
): string | undefined => {
  const required = new Set(manifest.collection_versions.map((copy) => copy.digest));
  const copies = new Map(
    manifest.collection_versions.map((copy) => [copy.collection_version_id, copy]),
  );
  const snapshots = new Set(manifest.snapshot_digests);
  const covered = new Set<Digest>();
  for (const digest of [
    ...plan.localArchives.map((archive) => archive.digest),
    ...plan.reusable,
    ...plan.download,
  ]) {
    if (!required.has(digest)) return `plan references foreign retained copy ${digest}`;
    covered.add(digest);
  }
  for (const digest of plan.download) {
    if (!snapshots.has(digest))
      return `plan requests a private download for source-backed retained copy ${digest}`;
  }
  for (const id of plan.reacquire) {
    const copy = copies.get(id);
    if (copy === undefined) return `unknown retained copy ${id}`;
    if (snapshots.has(copy.digest))
      return `snapshot-backed retained copy ${copy.digest} cannot be reacquired from source`;
    covered.add(copy.digest);
  }
  for (const digest of required) {
    if (!covered.has(digest)) return `retained copy ${digest} not downloaded`;
  }
  if (plan.download.length && !hasDownload)
    return `snapshot-backed retained copy ${plan.download[0]} not downloaded: no download transport`;
};

/** Resolve every required byte before writing any new immutable object. */
const completeRestoreArchives = Effect.fn("Library.completeRestoreArchives")(function* <
  E = never,
  R = never,
>(
  manifest: LibraryManifest,
  plan: CollectionVersionPlan,
  options: RestoreOptions & {
    readonly download?: (digest: Digest) => Effect.Effect<SnapshotArchive, E, R>;
  },
) {
  const invalid = invalidPlan(manifest, plan, options.download !== undefined);
  if (invalid !== undefined) return yield* new RestoreInvalid({ detail: invalid });
  const progress = options.progress ?? silentRestoreProgress;
  const archives = new Map(plan.localArchives.map((archive) => [archive.digest, archive]));
  const fs = yield* FileSystem.FileSystem;
  const existingPaths = new Map<string, string>();
  if (plan.reusable.length) {
    const phase = { kind: "verify-local", total: plan.reusable.length } as const;
    yield* progress.around(
      phase,
      Effect.gen(function* () {
        for (const [index, digest] of plan.reusable.entries()) {
          const path = collectionVersionPath(options.originalsPath, digest);
          const copy = manifest.collection_versions.find(
            (candidate) => candidate.digest === digest,
          );
          const subject =
            manifest.imports.find(
              (candidate) => candidate.collection_version_id === copy?.collection_version_id,
            )?.input.value ?? digest;
          yield* progress.tick({ phase, completed: index, subject });
          // Replan on retry rather than silently adding an unplanned transfer.
          if (!(yield* fs.exists(path)))
            return yield* new RestoreInvalid({
              detail: `retained copy ${digest} disappeared after planning`,
            });
          if ((yield* originalTreeHash(path)) !== digest)
            return yield* new ContentAddressCollision();
          existingPaths.set(digest, path);
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
          (digest) =>
            Effect.gen(function* () {
              if (options.download === undefined)
                return yield* new RestoreInvalid({
                  detail: `snapshot-backed retained copy ${digest} not downloaded`,
                });
              const archive = yield* options.download(digest);
              if (archive.digest !== digest)
                return yield* new RestoreInvalid({
                  detail: `download returned ${archive.digest}; expected ${digest}`,
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
      return yield* new RestoreInvalid({ detail: `unknown retained copy ${id}` });
    // A stale or mismatched plan must never turn private content into a source fetch.
    if (manifest.snapshot_digests.includes(copy.digest))
      return yield* new RestoreInvalid({
        detail: `snapshot-backed retained copy ${copy.digest} not downloaded`,
      });
    const subject =
      manifest.imports.find((candidate) => candidate.collection_version_id === id)?.input.value ??
      copy.digest;
    const archive = yield* progress.around(
      { kind: "fetch-source", subject },
      refetchSourceArchive(manifest, copy.digest, options),
    );
    archives.set(archive.digest, archive);
  }
  // Plans describe observations, not authority to omit required content.
  for (const copy of manifest.collection_versions) {
    if (!archives.has(copy.digest) && !existingPaths.has(copy.digest))
      return yield* new RestoreInvalid({ detail: `retained copy ${copy.digest} not downloaded` });
  }
  return { archives: [...archives.values()], existingPaths };
});

/**
 * Prepare the exact content a manifest requires, without saving Library state or rewriting
 * import history. Available snapshots and exact source reconstruction share verification.
 */
export const prepareRestore = Effect.fn("Library.prepareRestore")(function* <E = never, R = never>(
  manifest: LibraryManifest,
  plan: CollectionVersionPlan,
  options: RestoreOptions & {
    readonly download?: (digest: Digest) => Effect.Effect<SnapshotArchive, E, R>;
  },
) {
  const progress = options.progress ?? silentRestoreProgress;
  const { archives, existingPaths } = yield* completeRestoreArchives(manifest, plan, options);
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
            )?.input.value ?? tree.digest;
          yield* progress.tick({ phase, completed: index, subject: label });
          const archive = received.get(tree.digest);
          let path = verifiedPaths.get(tree.digest);
          if (path === undefined) {
            path = collectionVersionPath(options.originalsPath, tree.digest);
            if (yield* fs.exists(path)) {
              // Existing immutable objects still need verification, but no unpack/copy cycle.
              if ((yield* originalTreeHash(path)) !== tree.digest)
                return yield* new ContentAddressCollision();
            } else {
              if (archive === undefined)
                return yield* new RestoreInvalid({
                  detail: `retained copy ${tree.digest} not downloaded`,
                });
              const verified = yield* verifySnapshotArchive(archive);
              path = yield* Effect.scoped(
                Effect.gen(function* () {
                  const temporary = yield* materializeVerifiedSnapshot(verified);
                  return yield* writeCollectionVersion(
                    temporary,
                    options.originalsPath,
                    tree.digest,
                    true,
                  );
                }),
              );
            }
            verifiedPaths.set(tree.digest, path);
          }
          for (const member of tree.members) {
            const directory = member.source_path === "." ? path : join(path, member.source_path);
            if ((yield* originalTreeHash(directory)) !== member.source_digest)
              return yield* new RestoreInvalid({
                detail: `retained member ${member.source_path} source bytes disagree`,
              });
          }
          yield* progress.tick({ phase, completed: index + 1, subject: label });
        }
      }),
    );
  const state = yield* LibraryState.makeEffect(
    currentLibraryState({
      collections: [...manifest.collections],
      skills: [...manifest.skills],
      collection_versions: [...manifest.collection_versions],
      imports: [...manifest.imports],
      enabled: [...manifest.enabled],
      repositories: [],
      installed_skills: [],
      unmanaged: [],
    }),
  ).pipe(
    Effect.mapError(
      () => new RestoreInvalid({ detail: "restored state failed Library validation" }),
    ),
  );
  return { state };
});

/** Preview device facts that replacement of portable Library state would strand. */
export function strandedByRestore(current: LibraryState, manifest: LibraryManifest) {
  const skillIds = new Set(manifest.skills.map((item) => item.skill_id));
  const versionIds = new Set(
    manifest.skills.flatMap((skill) => skill.versions.map((version) => version.skill_version_id)),
  );
  const conflicts = [
    ...current.installed_skills.flatMap((installedSkill) =>
      (!enabledSkillIds(manifest, manifest.enabled).includes(installedSkill.skill_id) &&
        !repositorySelectsInstalledSkill(current, installedSkill)) ||
      (skillIds.has(installedSkill.skill_id) && versionIds.has(installedSkill.skill_version_id))
        ? []
        : [`device:${installedSkill.installed_skill_id}:managed-projection`],
    ),
    ...current.repositories.flatMap((repository) =>
      repository.enabled.every((item) =>
        "skill" in item
          ? manifest.skills.some((skill) => skill.skill_id === item.skill)
          : manifest.collections.some((collection) => collection.collection_id === item.collection),
      )
        ? []
        : [`device:${repository.root}:repository-binding`],
    ),
  ];
  return [...new Set(conflicts)].sort();
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
  if (ownership.length > 0) return yield* new RestoreInvalid({ detail: ownership.join(", ") });
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
      () =>
        new RestoreInvalid({
          detail: "merged Library conflicts with what this device enables or owns",
        }),
    ),
  );
});
