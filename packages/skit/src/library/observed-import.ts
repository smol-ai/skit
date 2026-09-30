import { Effect, FileSystem, Schema, SchemaIssue } from "effect";
import { dirname, join } from "node:path";
import { deterministicTreeHashEffect, validateSkitDirectoryEffect } from "../artifact/skit.js";
import { InvalidLibraryState } from "../failures.js";
import { copyLocalTreeEffect } from "../platform/copy-tree.js";
import { writeJsonAtomicEffect } from "../platform/atomic-write.js";
import {
  makeAcquisitionId,
  makeCollectionId,
  makeMachineId,
  makeRetainedCopyId,
  makeSkillId,
  makeSkillVersionId,
  MachineId,
} from "./entity-ids.js";
import { MachineDocumentJson, MachineDocumentV4 } from "./machine-document.js";
import { acquisitionObservations } from "./acquisition-evidence.js";
import {
  Acquisition,
  type MaterializationProfile,
  type SkitSource,
  sourceAcquisitions,
  type SourceRevision,
  SourceIdentity,
  SourceTracking,
} from "./library-contracts.js";
import {
  LibraryState,
  decodeLibraryState,
  libraryManifestFromLocalStateEffect,
} from "./library-state.js";
import { LibraryStore } from "./store/library-store.js";
import { originalTreeHashEffect, retainLocalTreeEffect } from "./retention/retain-tree.js";
import { materializedSkillDigestEffect } from "./skill-materialization.js";
import {
  collectionLabelFromSource,
  sourceIdentityFromSource,
  type SourceDeclaration,
} from "./source-identity.js";
import type { Digest, SkillsShProvenanceObservation } from "./store/state-schema.js";

const readOrCreateMachineId = Effect.fn("Library.readOrCreateMachineId")(function* (
  libraryHome: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = join(libraryHome, "machine.json");
  const text = yield* fs
    .readFileString(path)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
  if (text !== undefined) {
    const document = yield* Schema.decodeUnknownEffect(MachineDocumentJson)(text);
    if (document.machineId !== undefined) return document.machineId;
    const machineId = makeMachineId();
    yield* writeJsonAtomicEffect(
      path,
      yield* MachineDocumentV4.makeEffect({
        schemaVersion: 4,
        machineId,
        displayName: document.displayName ?? "SKIT machine",
        discoveryRoots: document.discoveryRoots,
        repositories: document.repositories,
      }),
    );
    return machineId;
  }
  const machineId = makeMachineId();
  yield* writeJsonAtomicEffect(path, {
    schemaVersion: 4,
    machineId,
    displayName: "SKIT machine",
    discoveryRoots: [],
    repositories: [],
  });
  return machineId;
});

export class ObservedImportInvalid extends Schema.TaggedError<ObservedImportInvalid>()(
  "Library.ObservedImportInvalid",
  { reason: Schema.String },
) {}

export interface ObservedSkill {
  readonly name: string;
  readonly sourcePath: string;
  readonly relativePath: string;
  readonly observedHash: Digest;
}
export interface ObservedImport {
  readonly machineId?: MachineId;
  readonly input: string;
  readonly source: SkitSource;
  readonly declaration?: SourceDeclaration;
  /** Exactly what the bytes came from, where the Source protocol names it. */
  readonly revision?: SourceRevision;
  readonly retainedAt: string;
  readonly skills: readonly ObservedSkill[];
  readonly observations: readonly SkillsShProvenanceObservation[];
  readonly retainLocalEntry?: boolean;
}

const safeRelative = (path: string) =>
  (path === "." || path.length > 0) &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  (path === "." || path.split("/").every((part) => part !== "" && part !== "." && part !== ".."));

interface PreparedFact {
  readonly name: string;
  readonly sourcePath: string;
  readonly sourceDigest: Digest;
  readonly artifactDigest: Digest;
  readonly validationDigest: Digest;
  readonly materializationProfile: MaterializationProfile;
}

export const prepareObservedCollectionEffect = Effect.fn("Library.prepareObservedCollection")(
  function* (skills: ObservedImport["skills"]) {
    const paths = new Set<string>();
    const names = new Set<string>();
    if (skills.length === 0)
      return yield* new ObservedImportInvalid({ reason: "empty observed Collection" });
    for (const skill of skills) {
      if (!safeRelative(skill.relativePath))
        return yield* new ObservedImportInvalid({ reason: "unsafe Skill path" });
      if (
        names.has(skill.name) ||
        [...paths].some(
          (path) =>
            path === "." ||
            skill.relativePath === "." ||
            path === skill.relativePath ||
            path.startsWith(`${skill.relativePath}/`) ||
            skill.relativePath.startsWith(`${path}/`),
        )
      )
        return yield* new ObservedImportInvalid({ reason: "duplicate Skill path or name" });
      paths.add(skill.relativePath);
      names.add(skill.name);
    }
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-observed-v4-" });
    const staged = join(workspace, "verbatim");
    if (skills[0]?.relativePath !== ".") yield* fs.makeDirectory(staged);
    const facts: PreparedFact[] = [];
    for (const skill of skills) {
      const path = join(staged, skill.relativePath);
      yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
      yield* copyLocalTreeEffect(
        skill.sourcePath,
        path,
        [
          join(skill.sourcePath, ".git"),
          join(skill.sourcePath, ".skit"),
          join(skill.sourcePath, ".skit-ownership.json"),
        ],
        true,
      );
      if ((yield* deterministicTreeHashEffect(path)) !== skill.observedHash)
        return yield* new ObservedImportInvalid({
          reason: `observed Skill ${skill.name} changed`,
        });
      facts.push({
        name: skill.name,
        sourcePath: skill.relativePath,
        sourceDigest: yield* originalTreeHashEffect(path),
        artifactDigest: yield* Effect.scoped(
          materializedSkillDigestEffect({ retainedRoot: staged, sourcePath: skill.relativePath }),
        ),
        validationDigest: skill.observedHash,
        materializationProfile: "plain-skill/v1",
      });
    }
    return { staged, facts, digest: yield* originalTreeHashEffect(staged) };
  },
);

const formatManifestIssue = SchemaIssue.makeFormatterDefault();

interface PersistPreparedRequest extends ObservedImport {
  readonly retainedRoot: string;
  readonly retainedDigest: Digest;
  readonly facts: readonly PreparedFact[];
  readonly sourceIdentity?: SourceIdentity;
  readonly label?: string;
}

const persistPrepared = Effect.fn("Library.persistPreparedCollection")(function* (
  request: PersistPreparedRequest,
) {
  const store = yield* LibraryStore;
  const machineId = request.machineId ?? (yield* readOrCreateMachineId(store.home));
  const state = yield* store.load;
  const source =
    request.sourceIdentity ??
    sourceIdentityFromSource(request.source, machineId, request.declaration);
  // A local checkout's commit says nothing about where its bytes can be fetched again.
  const revision =
    request.revision?.kind === "commit" && (source.kind === "github" || source.kind === "git")
      ? request.revision.commit
      : request.revision?.kind === "release" && source.kind === "registry"
        ? request.revision.version
        : undefined;
  const requestedGitRef =
    request.source.type === "git" || request.source.type === "github"
      ? request.source.ref
      : undefined;
  const refreshTracking =
    requestedGitRef === undefined
      ? ({ kind: "default" } as const)
      : /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(requestedGitRef)
        ? ({ kind: "commit", ref: requestedGitRef } as const)
        : ({ kind: "branch", ref: requestedGitRef } as const);
  let collection = state.collections.find(
    (candidate) =>
      (candidate.upstream !== undefined &&
        Schema.toEquivalence(SourceIdentity)(candidate.upstream.source_identity, source) &&
        Schema.toEquivalence(SourceTracking)(candidate.upstream.tracking, refreshTracking)) ||
      (candidate.upstream === undefined &&
        sourceAcquisitions(state, candidate.collection_id).some((acquisition) =>
          Schema.toEquivalence(SourceIdentity)(acquisition.source_identity, source),
        )),
  );
  if (collection === undefined) {
    collection = {
      collection_id: makeCollectionId(),
      label: request.label ?? collectionLabelFromSource(request.source, request.declaration),
      ...(source.kind === "local"
        ? {}
        : { upstream: { source_identity: source, tracking: refreshTracking } }),
    };
    state.collections.push(collection);
  }
  const collectionId = collection.collection_id;
  const retainedCopy = state.retained_copies.find(
    (candidate) => candidate.digest === request.retainedDigest,
  );
  const retainedCopyId = retainedCopy?.retained_copy_id ?? makeRetainedCopyId();
  const acquisition: Acquisition = {
    acquisition_id: makeAcquisitionId(),
    collection_id: collectionId,
    kind: "source",
    retained_copy_id: retainedCopyId,
    source_identity: source,
    input: { value: request.input },
    ...(revision === undefined ? {} : { revision }),
    acquired_at: request.retainedAt,
    machine_id: machineId,
    observations: acquisitionObservations(request.observations, machineId),
  };
  const skillAt = (path: string) =>
    state.skills.find((skill) => skill.collection_id === collectionId && skill.path === path);
  // Seeing exactly what was last acquired from this Source changes nothing, so record nothing.
  const previous = sourceAcquisitions(state, collectionId)[0];
  const unchangedSkills = request.facts.map((fact) => skillAt(fact.sourcePath));
  if (
    previous !== undefined &&
    Schema.toEquivalence(Acquisition)(previous, {
      ...acquisition,
      acquisition_id: previous.acquisition_id,
      acquired_at: previous.acquired_at,
    }) &&
    unchangedSkills.every((skill) => skill !== undefined)
  )
    return { collection, skills: unchangedSkills };
  const previousCopy = state.retained_copies.find(
    (copy) => copy.retained_copy_id === previous?.retained_copy_id,
  );
  const persistedSkills = [];
  for (const fact of request.facts) {
    let skill = skillAt(fact.sourcePath);
    if (skill === undefined) {
      skill = {
        skill_id: makeSkillId(),
        collection_id: collectionId,
        path: fact.sourcePath,
        name: fact.name,
        versions: [],
      };
      state.skills.push(skill);
    }
    persistedSkills.push(skill);
    if (!skill.versions.some((candidate) => candidate.artifact_digest === fact.artifactDigest))
      skill.versions.push({
        skill_version_id: makeSkillVersionId(),
        source_digest: fact.sourceDigest,
        artifact_digest: fact.artifactDigest,
        validation_identity_digest: fact.validationDigest,
        materialization_profile: fact.materializationProfile,
      });
    // A retained local edit is used until the Source changes this Skill.
    const previousMember = previousCopy?.members.find(
      (member) => member.source_path === fact.sourcePath,
    );
    if (previousMember?.artifact_digest !== fact.artifactDigest) delete skill.local_version_id;
  }
  if (retainedCopy === undefined)
    state.retained_copies.push({
      retained_copy_id: retainedCopyId,
      digest: request.retainedDigest,
      copy_profile: "verbatim/v1",
      members: request.facts.map((fact) => ({
        source_path: fact.sourcePath,
        source_digest: fact.sourceDigest,
        artifact_digest: fact.artifactDigest,
        materialization_profile: fact.materializationProfile,
      })),
    });
  state.acquisitions.push(acquisition);
  const successor = yield* decodeLibraryState(state).pipe(
    Effect.mapError(
      (error) =>
        new InvalidLibraryState({
          path: join(store.home, "state.json"),
          detail: `observed Collection failed validation: ${String(error)}`,
        }),
    ),
  );
  yield* libraryManifestFromLocalStateEffect(successor).pipe(
    Effect.mapError(
      (error) =>
        new InvalidLibraryState({
          path: join(store.home, "state.json"),
          detail: `observed Collection would violate the portable manifest: ${formatManifestIssue(error)}`,
        }),
    ),
  );
  yield* store.publish(successor);
  return {
    collection,
    skills: persistedSkills.map((skill) =>
      successor.skills.find((candidate) => candidate.skill_id === skill.skill_id)!,
    ),
  };
});

/** Retain observed bytes while the caller holds Library write authority. */
export const retainObservedCollectionEffect = Effect.fn("Library.retainObservedCollection")(
  function* (request: ObservedImport) {
    const store = yield* LibraryStore;
    const prepared = yield* prepareObservedCollectionEffect(request.skills);
    const retainedRoot = yield* retainLocalTreeEffect(
      prepared.staged,
      store.originalsPath,
      prepared.digest,
      true,
    );
    return yield* persistPrepared({
      ...request,
      retainedRoot,
      retainedDigest: prepared.digest,
      facts: prepared.facts,
    });
  },
);

export class ProjectionObservationChanged extends Schema.TaggedError<ProjectionObservationChanged>()(
  "Library.ProjectionObservationChanged",
  { path: Schema.String },
) {}

/**
 * Retain one explicitly selected managed Projection as a new Version of its existing Skill.
 *
 * The Acquisition records only the local path and machine that were actually observed. It does
 * not alter the Collection's upstream or attribute the changed bytes to that upstream.
 */
export const retainChangedProjectionEffect = Effect.fn("Library.retainChangedProjection")(
  function* (request: {
    readonly skillId: LibraryState["skills"][number]["skill_id"];
    readonly projectionId: LibraryState["projections"][number]["projection_id"];
    readonly path: string;
    readonly observedHash: Digest;
    readonly retainedAt: string;
  }) {
    const store = yield* LibraryStore;
    const current = yield* store.inspect;
    if (!current.present)
      return yield* new InvalidLibraryState({
        path: join(store.home, "state.json"),
        detail: "Projection retention requires current Library state",
      });
    const state = structuredClone(current.state);
    const skill = state.skills.find((candidate) => candidate.skill_id === request.skillId);
    const projection = state.projections.find(
      (candidate) => candidate.projection_id === request.projectionId,
    );
    if (
      skill === undefined ||
      projection === undefined ||
      projection.skill_id !== skill.skill_id ||
      projection.path !== request.path
    )
      return yield* new ProjectionObservationChanged({ path: request.path });

    const prepared = yield* prepareObservedCollectionEffect([
      {
        name: "projection-observation",
        sourcePath: request.path,
        relativePath: ".",
        observedHash: request.observedHash,
      },
    ]).pipe(
      Effect.catchTag("Library.ObservedImportInvalid", () =>
        Effect.fail(new ProjectionObservationChanged({ path: request.path })),
      ),
    );
    yield* retainLocalTreeEffect(prepared.staged, store.originalsPath, prepared.digest, true);
    const fact = prepared.facts[0]!;
    const machineId = yield* readOrCreateMachineId(store.home);
    const retainedCopy = state.retained_copies.find(
      (candidate) => candidate.digest === prepared.digest,
    );
    const retainedCopyId = retainedCopy?.retained_copy_id ?? makeRetainedCopyId();
    const version = skill.versions.find(
      (candidate) => candidate.artifact_digest === fact.artifactDigest,
    ) ?? {
      skill_version_id: makeSkillVersionId(),
      source_digest: fact.sourceDigest,
      artifact_digest: fact.artifactDigest,
      validation_identity_digest: fact.validationDigest,
      materialization_profile: fact.materializationProfile,
    };
    if (retainedCopy === undefined)
      state.retained_copies.push({
        retained_copy_id: retainedCopyId,
        digest: prepared.digest,
        copy_profile: "verbatim/v1",
        members: [
          {
            source_path: ".",
            source_digest: fact.sourceDigest,
            artifact_digest: fact.artifactDigest,
            materialization_profile: fact.materializationProfile,
          },
        ],
      });
    state.acquisitions.push({
      acquisition_id: makeAcquisitionId(),
      collection_id: skill.collection_id,
      kind: "retained-edit",
      retained_copy_id: retainedCopyId,
      source_identity: {
        kind: "local",
        machine_id: machineId,
        path: { value: request.path },
      },
      input: { value: request.path },
      acquired_at: request.retainedAt,
      machine_id: machineId,
      observations: [],
    });
    if (!skill.versions.includes(version)) skill.versions.push(version);
    skill.local_version_id = version.skill_version_id;
    const successor = yield* decodeLibraryState(state).pipe(
      Effect.mapError(
        (error) =>
          new InvalidLibraryState({
            path: join(store.home, "state.json"),
            detail: `Projection retention produced invalid Library state: ${String(error)}`,
          }),
      ),
    );
    yield* libraryManifestFromLocalStateEffect(successor).pipe(
      Effect.mapError(
        (error) =>
          new InvalidLibraryState({
            path: join(store.home, "state.json"),
            detail: `Projection retention would violate the portable manifest: ${formatManifestIssue(error)}`,
          }),
      ),
    );
    yield* store.publish(successor);
    return {
      skillVersionId: version.skill_version_id,
      retainedCopyId,
      snapshotDigest: prepared.digest,
      artifactDigest: fact.artifactDigest,
    };
  },
);

export interface AuthoredImport {
  readonly machineId?: MachineId;
  readonly root: string;
  readonly source: SkitSource;
  readonly sourceIdentity?: SourceIdentity;
  readonly label?: string;
  readonly declaration?: SourceDeclaration;
  readonly input: string;
  /** Exactly what the bytes came from, where the Source protocol names it. */
  readonly revision?: SourceRevision;
  readonly retainedAt: string;
}
export const retainAuthoredCollectionUnderLockEffect = Effect.fn(
  "Library.retainAuthoredCollectionUnderLock",
)(function* (request: AuthoredImport) {
  const validated = yield* validateSkitDirectoryEffect(request.root, "retained", {
    assessmentContext: "retain",
  });
  if (validated.diagnostics.some((item) => item.severity === "error"))
    return yield* new ObservedImportInvalid({
      reason: "authored Descriptor or Skill content is invalid",
    });
  const store = yield* LibraryStore;
  const retainedDigest = yield* originalTreeHashEffect(request.root);
  const retainedRoot = yield* retainLocalTreeEffect(
    request.root,
    store.originalsPath,
    retainedDigest,
    true,
  );
  const validationByName = new Map(validated.identity.skills.map((skill) => [skill.name, skill]));
  const facts: PreparedFact[] = [];
  for (const member of validated.descriptor.skills) {
    const identity = validationByName.get(member.name);
    if (identity === undefined)
      return yield* new ObservedImportInvalid({
        reason: `authored Skill ${member.name} has no validation identity`,
      });
    facts.push({
      name: member.name,
      sourcePath: member.path,
      sourceDigest: yield* originalTreeHashEffect(join(retainedRoot, member.path)),
      artifactDigest: yield* Effect.scoped(
        materializedSkillDigestEffect({
          retainedRoot,
          sourcePath: member.path,
          shared: member.shared,
        }),
      ),
      validationDigest: identity.contentHash,
      materializationProfile: "declared-skit-skill/v1",
    });
  }
  return yield* persistPrepared({
    ...request,
    skills: [],
    observations: [],
    retainedRoot,
    retainedDigest,
    facts,
  });
});
