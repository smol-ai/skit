import type { RetainedContentPlan } from "./retained-content-plan.js";
import type { RestoreObserver, RestorePhase } from "./restore-progress.js";
import type { Digest } from "../contracts.js";
import { ContentAddressCollision } from "../failures.js";
import { retainedTreePath } from "./retention/retain-tree.js";
import { resolveSkitSourceEffect } from "../acquisition/sources.js";
import { deterministicTreeHashEffect } from "../artifact/skit.js";
import { prepareObservedCollectionEffect } from "./observed-import.js";
import { Data, Effect, FileSystem } from "effect";
import { join } from "node:path";
import { originalTreeHashEffect, retainLocalTreeEffect } from "./retention/retain-tree.js";
import {
  captureSnapshotArchiveEffect,
  materializeVerifiedSnapshotEffect,
} from "./snapshot-archive.js";
import { verifySnapshotArchiveEffect } from "./snapshot-archive-universal.js";
import { currentLibraryState, LibraryState } from "./library-state.js";
import {
  acquisitionIsSourceRestorable,
  type Acquisition,
  type SkitSource,
  bindingSkillIds,
  currentLibraryManifest,
  librarySnapshotDigests,
  type LibraryManifest,
  type SnapshotArchive,
} from "./library-contracts.js";
import { repositorySelectsProjection } from "./installation/retire-unbound.js";
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
  readonly observer?: RestoreObserver;
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
 * The Source to reacquire an Acquisition's exact bytes from: its recorded identity at its
 * revision. Git restores pin the commit separately; a Registry restore names the Release.
 */
const restorableSource = (acquisition: Acquisition): SkitSource | undefined => {
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

const reacquireSourceArchiveEffect = Effect.fn("Library.restore.reacquireSource")(function* (
  manifest: LibraryManifest,
  digest: string,
  options: RestoreOptions,
) {
  const copy = manifest.retained_copies.find((candidate) => candidate.digest === digest);
  const acquisition = manifest.acquisitions.find(
    (candidate) =>
      candidate.retained_copy_id === copy?.retained_copy_id &&
      acquisitionIsSourceRestorable(candidate),
  );
  if (copy === undefined || acquisition === undefined)
    return yield* new SourceRestoreInvalid({
      digest,
      detail: "manifest has no exact source-restoration acquisition",
    });
  const archive = yield* Effect.scoped(
    Effect.gen(function* () {
      const gitSource =
        acquisition.source_identity.kind === "github" || acquisition.source_identity.kind === "git";
      const commit = gitSource ? acquisition.revision : undefined;
      if (gitSource && commit === undefined)
        return yield* new SourceRestoreInvalid({
          digest,
          detail: "pinned Git acquisition has no commit",
        });
      const source = restorableSource(acquisition);
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
      const resolved = yield* resolveSkitSourceEffect(source, {
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
    return yield* new SourceRestoreInvalid({
      digest,
      detail: `source returned ${archive.digest}; expected ${digest}`,
    });
  return archive;
});

const silentObserver: RestoreObserver = {
  around: (_phase, operation) => operation,
  tick: () => Effect.void,
};

/** Reject incomplete or foreign plans before any I/O. Observations still need byte verification. */
const invalidPlan = (
  manifest: LibraryManifest,
  plan: RetainedContentPlan,
  hasDownload: boolean,
): string | undefined => {
  const required = new Set(manifest.retained_copies.map((copy) => copy.digest));
  const copies = new Map(manifest.retained_copies.map((copy) => [copy.retained_copy_id, copy]));
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
const completeRestoreArchivesEffect = Effect.fn("Library.completeRestoreArchives")(function* <
  E = never,
  R = never,
>(
  manifest: LibraryManifest,
  plan: RetainedContentPlan,
  options: RestoreOptions & {
    readonly download?: (digest: Digest) => Effect.Effect<SnapshotArchive, E, R>;
  },
) {
  const invalid = invalidPlan(manifest, plan, options.download !== undefined);
  if (invalid !== undefined) return yield* new RestoreInvalid({ detail: invalid });
  const observer = options.observer ?? silentObserver;
  const archives = new Map(plan.localArchives.map((archive) => [archive.digest, archive]));
  const fs = yield* FileSystem.FileSystem;
  const existingPaths = new Map<string, string>();
  if (plan.reusable.length) {
    const phase = { kind: "verify-local", total: plan.reusable.length } as const;
    yield* observer.around(
      phase,
      Effect.gen(function* () {
        for (const [index, digest] of plan.reusable.entries()) {
          const path = retainedTreePath(options.originalsPath, digest);
          const copy = manifest.retained_copies.find((candidate) => candidate.digest === digest);
          const subject =
            manifest.acquisitions.find(
              (candidate) => candidate.retained_copy_id === copy?.retained_copy_id,
            )?.input.value ?? digest;
          yield* observer.tick({ phase, completed: index, subject });
          // Replan on retry rather than silently adding an unplanned transfer.
          if (!(yield* fs.exists(path)))
            return yield* new RestoreInvalid({
              detail: `retained copy ${digest} disappeared after planning`,
            });
          if ((yield* originalTreeHashEffect(path)) !== digest)
            return yield* new ContentAddressCollision();
          existingPaths.set(digest, path);
          yield* observer.tick({ phase, completed: index + 1, subject });
        }
      }),
    );
  }
  if (plan.download.length) {
    const phase = { kind: "download", total: plan.download.length } as const;
    let completed = 0;
    const downloaded = yield* observer.around(
      phase,
      Effect.gen(function* () {
        yield* observer.tick({ phase, completed: 0 });
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
              yield* observer.tick({ phase, completed: ++completed });
              return archive;
            }),
          { concurrency: 4 },
        );
      }),
    );
    for (const archive of downloaded) archives.set(archive.digest, archive);
  }
  for (const id of plan.reacquire) {
    const copy = manifest.retained_copies.find((candidate) => candidate.retained_copy_id === id);
    if (copy === undefined)
      return yield* new RestoreInvalid({ detail: `unknown retained copy ${id}` });
    // A stale or mismatched plan must never turn private content into a source fetch.
    if (manifest.snapshot_digests.includes(copy.digest))
      return yield* new RestoreInvalid({
        detail: `snapshot-backed retained copy ${copy.digest} not downloaded`,
      });
    const subject =
      manifest.acquisitions.find((candidate) => candidate.retained_copy_id === id)?.input.value ??
      copy.digest;
    const archive = yield* observer.around(
      { kind: "fetch-source", subject },
      reacquireSourceArchiveEffect(manifest, copy.digest, options),
    );
    archives.set(archive.digest, archive);
  }
  // Plans describe observations, not authority to omit required content.
  for (const copy of manifest.retained_copies) {
    if (!archives.has(copy.digest) && !existingPaths.has(copy.digest))
      return yield* new RestoreInvalid({ detail: `retained copy ${copy.digest} not downloaded` });
  }
  return { archives: [...archives.values()], existingPaths };
});

/**
 * Prepare the exact content a manifest requires, without saving Library state or rewriting
 * Acquisition provenance. Available snapshots and exact source reconstruction share verification.
 */
export const prepareRestoreEffect = Effect.fn("Library.prepareRestore")(function* <
  E = never,
  R = never,
>(
  manifest: LibraryManifest,
  plan: RetainedContentPlan,
  options: RestoreOptions & {
    readonly download?: (digest: Digest) => Effect.Effect<SnapshotArchive, E, R>;
  },
) {
  const observer = options.observer ?? silentObserver;
  const { archives, existingPaths } = yield* completeRestoreArchivesEffect(manifest, plan, options);
  const received = new Map(archives.map((archive) => [archive.digest, archive]));
  const fs = yield* FileSystem.FileSystem;
  const verifiedPaths = new Map(existingPaths);
  const phase: RestorePhase = { kind: "retain", total: manifest.retained_copies.length };
  if (phase.total)
    yield* observer.around(
      phase,
      Effect.gen(function* () {
        for (const [index, tree] of manifest.retained_copies.entries()) {
          const label =
            manifest.acquisitions.find(
              (candidate) => candidate.retained_copy_id === tree.retained_copy_id,
            )?.input.value ?? tree.digest;
          yield* observer.tick({ phase, completed: index, subject: label });
          const archive = received.get(tree.digest);
          let path = verifiedPaths.get(tree.digest);
          if (path === undefined) {
            path = retainedTreePath(options.originalsPath, tree.digest);
            if (yield* fs.exists(path)) {
              // Existing immutable objects still need verification, but no unpack/copy cycle.
              if ((yield* originalTreeHashEffect(path)) !== tree.digest)
                return yield* new ContentAddressCollision();
            } else {
              if (archive === undefined)
                return yield* new RestoreInvalid({
                  detail: `retained copy ${tree.digest} not downloaded`,
                });
              const verified = yield* verifySnapshotArchiveEffect(archive);
              path = yield* Effect.scoped(
                Effect.gen(function* () {
                  const temporary = yield* materializeVerifiedSnapshotEffect(verified);
                  return yield* retainLocalTreeEffect(
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
            if ((yield* originalTreeHashEffect(directory)) !== member.source_digest)
              return yield* new RestoreInvalid({
                detail: `retained member ${member.source_path} source bytes disagree`,
              });
          }
          yield* observer.tick({ phase, completed: index + 1, subject: label });
        }
      }),
    );
  const state = yield* LibraryState.makeEffect(
    currentLibraryState({
      collections: [...manifest.collections],
      skills: [...manifest.skills],
      retained_copies: [...manifest.retained_copies],
      acquisitions: [...manifest.acquisitions],
      global_bindings: [...manifest.bindings],
      local_bindings: [],
      projections: [],
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
export function restoreCustodyConflicts(current: LibraryState, manifest: LibraryManifest) {
  const skillIds = new Set(manifest.skills.map((item) => item.skill_id));
  const versionIds = new Set(
    manifest.skills.flatMap((skill) => skill.versions.map((version) => version.skill_version_id)),
  );
  const conflicts = [
    ...current.projections.flatMap((projection) =>
      (!manifest.bindings.some((binding) =>
        bindingSkillIds(manifest, binding).includes(projection.skill_id),
      ) &&
        !repositorySelectsProjection(current, projection)) ||
      (skillIds.has(projection.skill_id) && versionIds.has(projection.skill_version_id))
        ? []
        : [`device:${projection.projection_id}:managed-projection`],
    ),
    ...current.local_bindings.flatMap((binding) => {
      return binding.entries.every((entry) =>
        entry.kind === "skill"
          ? manifest.skills.some((skill) => skill.skill_id === entry.skill_id)
          : manifest.collections.some(
              (collection) => collection.collection_id === entry.collection_id,
            ),
      )
        ? []
        : [`device:${binding.scope.root}:repository-binding`];
    }),
  ];
  return [...new Set(conflicts)].sort();
}

/** Keep current device custody while replacing the portable Library fields. */
export const blendRestoredStateEffect = Effect.fn("Library.blendRestoredState")(function* (
  current: LibraryState,
  restored: LibraryState,
) {
  const manifest: LibraryManifest = currentLibraryManifest({
    collections: restored.collections,
    skills: restored.skills,
    retained_copies: restored.retained_copies,
    acquisitions: restored.acquisitions,
    snapshot_digests: librarySnapshotDigests(restored),
    bindings: restored.global_bindings.map(
      ({ invocation_policies: _policies, ...binding }) => binding,
    ),
  });
  const custody = restoreCustodyConflicts(current, manifest);
  if (custody.length > 0) return yield* new RestoreInvalid({ detail: custody.join(", ") });
  const localPolicies = current.global_bindings[0]?.invocation_policies;
  return yield* LibraryState.makeEffect({
    ...current,
    collections: restored.collections,
    skills: restored.skills,
    retained_copies: restored.retained_copies,
    acquisitions: restored.acquisitions,
    global_bindings: restored.global_bindings.map((binding) =>
      localPolicies === undefined ? binding : { ...binding, invocation_policies: localPolicies },
    ),
  }).pipe(
    Effect.mapError(
      () =>
        new RestoreInvalid({
          detail: "merged Library conflicts with device Bindings or custody",
        }),
    ),
  );
});
