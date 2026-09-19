import { Effect, FileSystem, Schema } from "effect";
import { dirname, join } from "node:path";
import { deterministicTreeHashEffect, validateSkitDirectoryEffect } from "../artifact/skit.js";
import { InvalidLibraryState } from "../failures.js";
import { collectionDisplay } from "../identity/catalog.js";
import { copyLocalTreeEffect } from "../platform/copy-tree.js";
import { writeJsonAtomicEffect } from "../platform/atomic-write.js";
import { canonicalJson } from "../shared/json.js";
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
import { portableObservations } from "./portable-evidence.js";
import type { AcquisitionSelection, MaterializationProfile } from "./portable-contracts.js";
import {
  LibraryState,
  decodeLibraryState,
  portableManifestFromLocalStateEffect,
} from "./portable-local-state.js";
import { LibraryStore } from "./store/library-store.js";
import { originalTreeHashEffect, retainLocalTreeEffect } from "./retention/retain-tree.js";
import { materializedSkillDigestEffect } from "./skill-materialization.js";
import { sourceIdentityFromCollectionIdentity } from "./source-identity.js";
import type {
  CollectionIdentity,
  Digest,
  SkitSource,
  SkillsShProvenanceObservation,
} from "./store/state-schema.js";

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

export class PortableObservedImportInvalid extends Schema.TaggedError<PortableObservedImportInvalid>()(
  "Library.PortableObservedImportInvalid",
  { reason: Schema.String },
) {}

export interface PortableObservedSkill {
  readonly name: string;
  readonly sourcePath: string;
  readonly relativePath: string;
  readonly observedHash: Digest;
}
export interface PortableObservedImport {
  readonly machineId?: MachineId;
  readonly identity: CollectionIdentity;
  readonly input: string;
  readonly source?: SkitSource;
  readonly sourceRevision?: string;
  readonly retainedAt: string;
  readonly skills: readonly PortableObservedSkill[];
  readonly observations: readonly SkillsShProvenanceObservation[];
  readonly retainLocalEntry?: boolean;
  /** Retention may be separated from selection when another workflow owns the selection commit. */
  readonly selectVersions?: boolean;
}

const safeRelative = (path: string) =>
  (path === "." || path.length > 0) &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  (path === "." || path.split("/").every((part) => part !== "" && part !== "." && part !== ".."));

const selection = (
  identity: CollectionIdentity,
  source: SkitSource | undefined,
  skills: PortableObservedImport["skills"],
): AcquisitionSelection => {
  if (source?.type === "well-known" && source.members?.length)
    return { kind: "selected-skills", names: [...new Set(source.members)].sort() };
  if (identity.profile !== "github-collection" && identity.profile !== "git-collection")
    return { kind: "full-tree" };
  const paths = [
    ...new Set(
      identity.skillPaths?.length ? identity.skillPaths : skills.map((skill) => skill.relativePath),
    ),
  ].sort();
  return paths.length === 0 || (paths.length === 1 && paths[0] === ".")
    ? { kind: "full-tree" }
    : { kind: "selected-paths", paths: paths.filter((path) => path !== ".") };
};

interface PreparedFact {
  readonly name: string;
  readonly sourcePath: string;
  readonly sourceDigest: Digest;
  readonly artifactDigest: Digest;
  readonly validationDigest: Digest;
  readonly materializationProfile: MaterializationProfile;
}

export const prepareObservedCollectionEffect = Effect.fn("Library.prepareObservedCollection")(
  function* (skills: PortableObservedImport["skills"]) {
    const paths = new Set<string>();
    const names = new Set<string>();
    if (skills.length === 0)
      return yield* new PortableObservedImportInvalid({ reason: "empty observed Collection" });
    for (const skill of skills) {
      if (!safeRelative(skill.relativePath))
        return yield* new PortableObservedImportInvalid({ reason: "unsafe Skill path" });
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
        return yield* new PortableObservedImportInvalid({ reason: "duplicate Skill path or name" });
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
        return yield* new PortableObservedImportInvalid({
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

interface PersistPreparedRequest extends PortableObservedImport {
  readonly retainedRoot: string;
  readonly retainedDigest: Digest;
  readonly facts: readonly PreparedFact[];
}

const persistPrepared = Effect.fn("Library.persistPreparedCollection")(function* (
  request: PersistPreparedRequest,
) {
  const store = yield* LibraryStore;
  const machineId = request.machineId ?? (yield* readOrCreateMachineId(store.home));
  const state = yield* store.load;
  const source = sourceIdentityFromCollectionIdentity(request.identity, machineId, request.input);
  const acquiredSelection = selection(request.identity, request.source, request.skills);
  const pinnedRevision =
    (source.kind === "github" || source.kind === "git") && request.sourceRevision !== undefined
      ? request.sourceRevision
      : undefined;
  const sourceKey = canonicalJson(source);
  const usesCollection =
    request.facts.every((fact) => fact.materializationProfile === "declared-skit-skill/v1") ||
    acquiredSelection.kind === "full-tree";
  let collection = usesCollection
    ? state.collections.find((candidate) => {
        if (
          candidate.upstream !== undefined &&
          canonicalJson(candidate.upstream.source_identity) === sourceKey
        )
          return true;
        if (source.kind !== "local") return false;
        const acquisitionIds = new Set(
          state.skills
            .filter((skill) => skill.collection_id === candidate.collection_id)
            .flatMap((skill) =>
              skill.versions.flatMap((version) =>
                version.origins.map((origin) => origin.acquisition_id),
              ),
            ),
        );
        return state.acquisitions.some(
          (acquisition) =>
            acquisitionIds.has(acquisition.acquisition_id) &&
            canonicalJson(acquisition.source_identity) === sourceKey,
        );
      })
    : undefined;
  if (usesCollection && collection === undefined) {
    collection = {
      collection_id: makeCollectionId(),
      label: collectionDisplay(request.identity),
      membership: {
        kind: request.facts.every(
          (fact) => fact.materializationProfile === "declared-skit-skill/v1",
        )
          ? "descriptor"
          : "source-tree",
      },
      ...(source.kind === "local"
        ? {}
        : {
            upstream: {
              source_identity: source,
              tracking: { kind: "default" },
              selection: acquiredSelection,
            },
          }),
    };
    state.collections.push(collection);
  }
  const retainedCopy = state.retained_copies.find(
    (candidate) => candidate.digest === request.retainedDigest,
  );
  const retainedCopyId = retainedCopy?.retained_copy_id ?? makeRetainedCopyId();
  const acquisitionId = makeAcquisitionId();
  const persistedSkills = [];
  for (const fact of request.facts) {
    const skillSelection =
      acquiredSelection.kind === "selected-skills"
        ? { kind: "selected-skills" as const, names: [fact.name] }
        : acquiredSelection.kind === "selected-paths"
          ? { kind: "selected-paths" as const, paths: [fact.sourcePath] }
          : acquiredSelection;
    let skill = state.skills.find((candidate) =>
      collection === undefined
        ? candidate.collection_id === undefined &&
          candidate.upstream !== undefined &&
          canonicalJson(candidate.upstream.source_identity) === sourceKey &&
          candidate.path === fact.sourcePath
        : candidate.collection_id === collection.collection_id &&
          candidate.path === fact.sourcePath,
    );
    if (skill === undefined) {
      skill = {
        skill_id: makeSkillId(),
        path: fact.sourcePath,
        name: fact.name,
        ...(collection === undefined
          ? source.kind === "local"
            ? {}
            : {
                upstream: {
                  source_identity: source,
                  tracking: { kind: "default" as const },
                  selection: skillSelection,
                },
              }
          : { collection_id: collection.collection_id }),
        versions: [],
      };
      state.skills.push(skill);
    }
    persistedSkills.push(skill);
    let version = skill.versions.find(
      (candidate) => candidate.artifact_digest === fact.artifactDigest,
    );
    const origin = { acquisition_id: acquisitionId, source_path: fact.sourcePath };
    if (version === undefined) {
      version = {
        skill_version_id: makeSkillVersionId(),
        source_digest: fact.sourceDigest,
        artifact_digest: fact.artifactDigest,
        validation_identity_digest: fact.validationDigest,
        materialization_profile: fact.materializationProfile,
        origins: [origin],
      };
      skill.versions.push(version);
    } else {
      const next = { ...version, origins: [...version.origins, origin] };
      skill.versions.splice(skill.versions.indexOf(version), 1, next);
      version = next;
    }
    if (request.selectVersions !== false)
      skill.selected_skill_version_id = version.skill_version_id;
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
  state.acquisitions.push({
    acquisition_id: acquisitionId,
    retained_copy_id: retainedCopyId,
    source_identity: source,
    tracking:
      pinnedRevision === undefined ? { kind: "default" } : { kind: "commit", ref: pinnedRevision },
    selection: acquiredSelection,
    input: { value: request.input },
    ...(pinnedRevision === undefined ? {} : { source_revision: pinnedRevision }),
    acquired_at: request.retainedAt,
    machine_id: machineId,
    observations: portableObservations(request.observations, machineId),
  });
  if (collection?.upstream !== undefined) {
    const revised = {
      ...collection,
      upstream: {
        ...collection.upstream,
        selection: acquiredSelection,
        last_acquisition_id: acquisitionId,
      },
    };
    state.collections[state.collections.indexOf(collection)] = revised;
  }
  for (const skill of persistedSkills) {
    if (skill.upstream === undefined) continue;
    const revised = {
      ...skill,
      upstream: { ...skill.upstream, last_acquisition_id: acquisitionId },
    };
    state.skills[state.skills.indexOf(skill)] = revised;
    persistedSkills[persistedSkills.indexOf(skill)] = revised;
  }
  const successor = yield* decodeLibraryState(state).pipe(
    Effect.mapError(
      (error) =>
        new InvalidLibraryState({
          path: join(store.home, "state.json"),
          detail: `observed Collection failed validation: ${String(error)}`,
        }),
    ),
  );
  yield* portableManifestFromLocalStateEffect(successor).pipe(
    Effect.mapError(
      (error) =>
        new InvalidLibraryState({
          path: join(store.home, "state.json"),
          detail: `observed Collection would violate the portable manifest: ${String(error)}`,
        }),
    ),
  );
  yield* store.publish(successor);
  return { collection, skills: persistedSkills };
});

/** Retain observed bytes while the caller holds Library write authority. */
export const retainObservedCollectionEffect = Effect.fn("Library.retainObservedCollection")(
  function* (request: PortableObservedImport) {
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

export class PortableProjectionObservationChanged extends Schema.TaggedError<PortableProjectionObservationChanged>()(
  "Library.PortableProjectionObservationChanged",
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
      return yield* new PortableProjectionObservationChanged({ path: request.path });

    const prepared = yield* prepareObservedCollectionEffect([
      {
        name: "projection-observation",
        sourcePath: request.path,
        relativePath: ".",
        observedHash: request.observedHash,
      },
    ]).pipe(
      Effect.catchTag("Library.PortableObservedImportInvalid", () =>
        Effect.fail(new PortableProjectionObservationChanged({ path: request.path })),
      ),
    );
    yield* retainLocalTreeEffect(prepared.staged, store.originalsPath, prepared.digest, true);
    const fact = prepared.facts[0]!;
    const machineId = yield* readOrCreateMachineId(store.home);
    const retainedCopy = state.retained_copies.find(
      (candidate) => candidate.digest === prepared.digest,
    );
    const retainedCopyId = retainedCopy?.retained_copy_id ?? makeRetainedCopyId();
    const acquisitionId = makeAcquisitionId();
    const version = {
      skill_version_id: makeSkillVersionId(),
      source_digest: fact.sourceDigest,
      artifact_digest: fact.artifactDigest,
      validation_identity_digest: fact.validationDigest,
      materialization_profile: fact.materializationProfile,
      origins: [{ acquisition_id: acquisitionId, source_path: "." as const }],
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
      acquisition_id: acquisitionId,
      retained_copy_id: retainedCopyId,
      source_identity: {
        kind: "local",
        machine_id: machineId,
        path: { value: request.path },
      },
      tracking: { kind: "default" },
      selection: { kind: "full-tree" },
      input: { value: request.path },
      acquired_at: request.retainedAt,
      machine_id: machineId,
      observations: [],
    });
    skill.versions.push(version);
    skill.selected_skill_version_id = version.skill_version_id;
    const successor = yield* decodeLibraryState(state).pipe(
      Effect.mapError(
        (error) =>
          new InvalidLibraryState({
            path: join(store.home, "state.json"),
            detail: `Projection retention produced invalid Library state: ${String(error)}`,
          }),
      ),
    );
    yield* portableManifestFromLocalStateEffect(successor).pipe(
      Effect.mapError(
        (error) =>
          new InvalidLibraryState({
            path: join(store.home, "state.json"),
            detail: `Projection retention would violate the portable manifest: ${String(error)}`,
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

export interface PortableAuthoredImport {
  readonly machineId?: MachineId;
  readonly root: string;
  readonly identity: CollectionIdentity;
  readonly input: string;
  readonly retainedAt: string;
  /** Retention may be separated from selection when another workflow owns the selection commit. */
  readonly selectVersions?: boolean;
}
export const retainAuthoredCollectionUnderLockEffect = Effect.fn(
  "Library.retainAuthoredCollectionUnderLock",
)(function* (request: PortableAuthoredImport) {
  const validated = yield* validateSkitDirectoryEffect(request.root, "retained", {
    assessmentContext: "retain",
  });
  if (validated.diagnostics.some((item) => item.severity === "error"))
    return yield* new PortableObservedImportInvalid({
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
      return yield* new PortableObservedImportInvalid({
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
