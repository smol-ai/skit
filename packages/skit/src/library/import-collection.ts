import { Data, Effect, FileSystem, Schema, SchemaIssue } from "effect";
import { dirname, join } from "node:path";
import { deterministicTreeHash, validateSkitDirectory } from "../artifact/skit.js";
import { InvalidLibraryState } from "../failures.js";
import { copyLocalTree } from "../platform/copy-tree.js";
import {
  makeImportId,
  makeCollectionId,
  makeCollectionVersionId,
  makeSkillId,
  makeSkillVersionId,
  MachineId,
} from "./entity-ids.js";
import * as MachineSettings from "./machine-settings.js";
import {
  Import,
  type MaterializationProfile,
  type SkillsShLockFileEntry,
  type SkitSource,
  sourceImports,
  type SourceRevision,
  SourceIdentity,
  SourceTracking,
} from "./library-contracts.js";
import {
  LibraryState,
  decodeLibraryState,
  libraryManifestFromLocalState,
} from "./library-state.js";
import { LibraryStore } from "./store/library-store.js";
import { originalTreeHash, writeCollectionVersion } from "./collection-version.js";
import { installedSkillDigest } from "./installed-skill-digest.js";
import {
  collectionLabelFromSource,
  sourceIdentityFromSource,
  type SourceDeclaration,
} from "./source-identity.js";
import type { Digest } from "../vocabulary.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

export class ImportRequestInvalid
  extends Data.TaggedError("Library.ImportRequestInvalid")<{
    reason: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
  readonly remediation =
    "Inspect the reported Skill paths in the source, correct the content, and retry.";
  get message(): string {
    return `Cannot import Collection: ${this.reason}`;
  }
}

export interface ImportRequestSkill {
  readonly name: string;
  readonly sourcePath: string;
  readonly relativePath: string;
  readonly currentHash: Digest;
}
export interface ImportRequest {
  readonly machineId?: MachineId;
  readonly input: string;
  readonly source: SkitSource;
  readonly declaration?: SourceDeclaration;
  /** Exactly what the bytes came from, where the Source protocol names it. */
  readonly revision?: SourceRevision;
  readonly importedAt: string;
  readonly skills: readonly ImportRequestSkill[];
  readonly lockFileEntries: readonly SkillsShLockFileEntry[];
}

const safeRelative = (path: string) =>
  (path === "." || path.length > 0) &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  (path === "." || path.split("/").every((part) => part !== "" && part !== "." && part !== ".."));

/** Member facts from verified retained bytes; `sourcePath` is relative to the retained copy. */
export interface ImportedSkillFact {
  readonly name: string;
  readonly sourcePath: string;
  readonly sourceDigest: Digest;
  readonly artifactDigest: Digest;
  readonly validationDigest: Digest;
  readonly materializationProfile: MaterializationProfile;
}

export const prepareImport = Effect.fn("Library.prepareImport")(function* (
  skills: ImportRequest["skills"],
) {
  const seen: ImportRequestSkill[] = [];
  if (skills.length === 0)
    return yield* new ImportRequestInvalid({ reason: "empty observed Collection" });
  for (const skill of skills) {
    if (!safeRelative(skill.relativePath))
      return yield* new ImportRequestInvalid({
        reason: `unsafe Skill path ${JSON.stringify(skill.relativePath)} for ${JSON.stringify(skill.name)}`,
      });
    const duplicate = seen.find((previous) => previous.name === skill.name);
    if (duplicate)
      return yield* new ImportRequestInvalid({
        reason: `duplicate Skill name ${JSON.stringify(skill.name)} at ${JSON.stringify(duplicate.relativePath)} and ${JSON.stringify(skill.relativePath)}`,
      });
    const overlap = seen.find(
      ({ relativePath: path }) =>
        path === "." ||
        skill.relativePath === "." ||
        path === skill.relativePath ||
        path.startsWith(`${skill.relativePath}/`) ||
        skill.relativePath.startsWith(`${path}/`),
    );
    if (overlap)
      return yield* new ImportRequestInvalid({
        reason: `overlapping Skill paths ${JSON.stringify(overlap.relativePath)} (${JSON.stringify(overlap.name)}) and ${JSON.stringify(skill.relativePath)} (${JSON.stringify(skill.name)})`,
      });
    seen.push(skill);
  }
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-observed-v4-" });
  const staged = join(workspace, "verbatim");
  if (skills[0]?.relativePath !== ".") yield* fs.makeDirectory(staged);
  const facts: ImportedSkillFact[] = [];
  for (const skill of skills) {
    const path = join(staged, skill.relativePath);
    yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
    yield* copyLocalTree(
      skill.sourcePath,
      path,
      [
        join(skill.sourcePath, ".git"),
        join(skill.sourcePath, ".skit"),
        join(skill.sourcePath, ".skit-ownership.json"),
      ],
      true,
    );
    if ((yield* deterministicTreeHash(path)) !== skill.currentHash)
      return yield* new ImportRequestInvalid({
        reason: `observed Skill ${skill.name} changed`,
      });
    facts.push({
      name: skill.name,
      sourcePath: skill.relativePath,
      sourceDigest: yield* originalTreeHash(path),
      artifactDigest: yield* Effect.scoped(
        installedSkillDigest({ collectionVersionPath: staged, sourcePath: skill.relativePath }),
      ),
      validationDigest: skill.currentHash,
      materializationProfile: "plain-skill/v1",
    });
  }
  return { staged, facts, digest: yield* originalTreeHash(staged) };
});

const formatManifestIssue = SchemaIssue.makeFormatterDefault();

interface PersistPreparedRequest extends ImportRequest {
  readonly collectionVersionDigest: Digest;
  readonly facts: readonly ImportedSkillFact[];
  readonly sourceIdentity?: SourceIdentity;
  readonly label?: string;
}

const persistPrepared = Effect.fn("Library.persistPreparedCollection")(function* (
  request: PersistPreparedRequest,
) {
  const store = yield* LibraryStore;
  const machineId = request.machineId ?? (yield* MachineSettings.ensureIdentity(store.home));
  const base = yield* store.load;
  const state = structuredClone(base);
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
        sourceImports(state, candidate.collection_id).some((sourceImport) =>
          Schema.toEquivalence(SourceIdentity)(sourceImport.source_identity, source),
        )),
  );
  const added = collection === undefined;
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
  const collectionVersion = state.collection_versions.find(
    (candidate) => candidate.digest === request.collectionVersionDigest,
  );
  const collectionVersionId = collectionVersion?.collection_version_id ?? makeCollectionVersionId();
  // Return the identity and facts of this retained copy, including on an unchanged import.
  // These contain no scoped paths, so callers can consume them after preparation closes.
  const imported = {
    collectionVersionId,
    snapshotDigest: request.collectionVersionDigest,
    members: request.facts,
  };
  const sourceImport: Import = {
    import_id: makeImportId(),
    collection_id: collectionId,
    kind: "source",
    collection_version_id: collectionVersionId,
    source_identity: source,
    input: { value: request.input },
    ...(revision === undefined ? {} : { revision }),
    imported_at: request.importedAt,
    machine_id: machineId,
    // The importing machine records the entries, as it records the import itself.
    lock_file_entries: request.lockFileEntries.map((entry) => ({
      ...entry,
      machine_id: machineId,
    })),
  };
  const skillAt = (path: string) =>
    state.skills.find((skill) => skill.collection_id === collectionId && skill.path === path);
  // Seeing exactly what was last acquired from this Source changes nothing, so record nothing.
  const previous = sourceImports(state, collectionId)[0];
  const unchangedSkills = request.facts.map((fact) => skillAt(fact.sourcePath));
  if (
    previous !== undefined &&
    Schema.toEquivalence(Import)(previous, {
      ...sourceImport,
      import_id: previous.import_id,
      imported_at: previous.imported_at,
    }) &&
    unchangedSkills.every((skill) => skill !== undefined)
  )
    return { action: "unchanged" as const, collection, skills: unchangedSkills, ...imported };
  const previousCopy = state.collection_versions.find(
    (copy) => copy.collection_version_id === previous?.collection_version_id,
  );
  const persistedSkills = [];
  // Import metadata can change without changing the Versions the Library uses.
  let versionsChanged = false;
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
    if (previousMember?.artifact_digest !== fact.artifactDigest) {
      delete skill.local_version_id;
      versionsChanged = true;
    }
  }
  if (collectionVersion === undefined)
    state.collection_versions.push({
      collection_version_id: collectionVersionId,
      digest: request.collectionVersionDigest,
      copy_profile: "verbatim/v1",
      members: request.facts.map((fact) => ({
        source_path: fact.sourcePath,
        source_digest: fact.sourceDigest,
        artifact_digest: fact.artifactDigest,
        materialization_profile: fact.materializationProfile,
      })),
    });
  state.imports.push(sourceImport);
  const successor = yield* decodeLibraryState(state).pipe(
    Effect.mapError(
      (error) =>
        new ImportRequestInvalid({
          reason: `observed Collection failed validation: ${String(error)}`,
        }),
    ),
  );
  yield* libraryManifestFromLocalState(successor).pipe(
    Effect.mapError(
      (error) =>
        new ImportRequestInvalid({
          reason: `observed Collection would violate the portable manifest: ${formatManifestIssue(error)}`,
        }),
    ),
  );
  const skills = persistedSkills.map((skill) =>
    successor.skills.find((candidate) => candidate.skill_id === skill.skill_id)!,
  );
  const action = added
    ? ("added" as const)
    : versionsChanged
      ? ("updated" as const)
      : ("unchanged" as const);
  yield* store.save(successor, base);
  return { action, collection, skills, ...imported };
});

/** Import scanned bytes and return what was imported while the caller holds Library write authority. */
export const importCollection = Effect.fn("Library.importCollection")(function* (
  request: ImportRequest,
) {
  const store = yield* LibraryStore;
  const prepared = yield* prepareImport(request.skills);
  yield* writeCollectionVersion(prepared.staged, store.originalsPath, prepared.digest, true);
  return yield* persistPrepared({
    ...request,
    collectionVersionDigest: prepared.digest,
    facts: prepared.facts,
  });
});

export class InstalledSkillChanged
  extends Data.TaggedError("Library.InstalledSkillChanged")<{ path: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Preview retaining the installed skill's changes again.";
  get message(): string {
    return `Installed skill changed after it was observed: ${this.path}`;
  }
}

/**
 * Retain one explicitly selected managed installed skill as a new Version of its existing Skill.
 *
 * The import records only the local path and machine that were actually observed. It does
 * not alter the Collection's upstream or attribute the changed bytes to that upstream.
 */
export const importEdit = Effect.fn("Library.importEdit")(function* (request: {
  readonly skillId: LibraryState["skills"][number]["skill_id"];
  readonly installedSkillId: LibraryState["installed_skills"][number]["installed_skill_id"];
  readonly path: string;
  readonly currentHash: Digest;
  readonly importedAt: string;
}) {
  const store = yield* LibraryStore;
  const current = yield* store.inspect;
  if (!current.present)
    return yield* new InvalidLibraryState({
      path: join(store.home, "state.json"),
      detail: "Retaining an installed skill's changes requires current Library state",
    });
  const state = structuredClone(current.state);
  const skill = state.skills.find((candidate) => candidate.skill_id === request.skillId);
  const installedSkill = state.installed_skills.find(
    (candidate) => candidate.installed_skill_id === request.installedSkillId,
  );
  if (
    skill === undefined ||
    installedSkill === undefined ||
    installedSkill.skill_id !== skill.skill_id ||
    installedSkill.path !== request.path
  )
    return yield* new InstalledSkillChanged({ path: request.path });

  const prepared = yield* prepareImport([
    {
      name: "projection-observation",
      sourcePath: request.path,
      relativePath: ".",
      currentHash: request.currentHash,
    },
  ]).pipe(
    Effect.catchTag("Library.ImportRequestInvalid", () =>
      Effect.fail(new InstalledSkillChanged({ path: request.path })),
    ),
  );
  yield* writeCollectionVersion(prepared.staged, store.originalsPath, prepared.digest, true);
  const fact = prepared.facts[0]!;
  const machineId = yield* MachineSettings.ensureIdentity(store.home);
  const collectionVersion = state.collection_versions.find(
    (candidate) => candidate.digest === prepared.digest,
  );
  const collectionVersionId = collectionVersion?.collection_version_id ?? makeCollectionVersionId();
  const version = skill.versions.find(
    (candidate) => candidate.artifact_digest === fact.artifactDigest,
  ) ?? {
    skill_version_id: makeSkillVersionId(),
    source_digest: fact.sourceDigest,
    artifact_digest: fact.artifactDigest,
    validation_identity_digest: fact.validationDigest,
    materialization_profile: fact.materializationProfile,
  };
  if (collectionVersion === undefined)
    state.collection_versions.push({
      collection_version_id: collectionVersionId,
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
  state.imports.push({
    import_id: makeImportId(),
    collection_id: skill.collection_id,
    kind: "edit",
    collection_version_id: collectionVersionId,
    source_identity: {
      kind: "local",
      machine_id: machineId,
      path: { value: request.path },
    },
    input: { value: request.path },
    imported_at: request.importedAt,
    machine_id: machineId,
    lock_file_entries: [],
  });
  if (!skill.versions.includes(version)) skill.versions.push(version);
  skill.local_version_id = version.skill_version_id;
  const successor = yield* decodeLibraryState(state).pipe(
    Effect.mapError(
      (error) =>
        new InvalidLibraryState({
          path: join(store.home, "state.json"),
          detail: `Retaining an installed skill's changes produced invalid Library state: ${String(error)}`,
        }),
    ),
  );
  yield* store.save(successor, current.state);
  return {
    skillVersionId: version.skill_version_id,
    collectionVersionId,
    snapshotDigest: prepared.digest,
    artifactDigest: fact.artifactDigest,
  };
});

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
  readonly importedAt: string;
}
export const importAuthoredCollection = Effect.fn("Library.retainAuthoredCollectionUnderLock")(
  function* (request: AuthoredImport) {
    const validated = yield* validateSkitDirectory(request.root, "retained", {
      assessmentContext: "import",
    });
    if (validated.diagnostics.some((item) => item.severity === "error"))
      return yield* new ImportRequestInvalid({
        reason: "authored Descriptor or Skill content is invalid",
      });
    const store = yield* LibraryStore;
    const collectionVersionDigest = yield* originalTreeHash(request.root);
    const collectionVersionPath = yield* writeCollectionVersion(
      request.root,
      store.originalsPath,
      collectionVersionDigest,
      true,
    );
    const validationByName = new Map(validated.identity.skills.map((skill) => [skill.name, skill]));
    const facts: ImportedSkillFact[] = [];
    for (const member of validated.descriptor.skills) {
      const identity = validationByName.get(member.name);
      if (identity === undefined)
        return yield* new ImportRequestInvalid({
          reason: `authored Skill ${member.name} has no validation identity`,
        });
      facts.push({
        name: member.name,
        sourcePath: member.path,
        sourceDigest: yield* originalTreeHash(join(collectionVersionPath, member.path)),
        artifactDigest: yield* Effect.scoped(
          installedSkillDigest({
            collectionVersionPath,
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
      lockFileEntries: [],
      collectionVersionDigest,
      facts,
    });
  },
);
