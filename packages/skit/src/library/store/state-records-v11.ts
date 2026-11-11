// Literal v11 record shapes, frozen at 3ffe1efa6. Never import current domain records here.
// Shared scalar identities retain their nominal types; record fields and validation stay historical.
import { Schema } from "effect";
// Passive diagnostic facts do not define or validate any historical record shape.
import { manifestViolationIssue } from "../manifest-violation.js";
import { isAbsolute } from "node:path";
import { canonicalJson } from "../../shared/json.js";
import { Hash } from "../../shared/hash.js";
import {
  CollectionId,
  SkillId,
  SkillVersionId,
  CollectionVersionId,
  ImportId,
  MachineId,
  InstalledSkillId,
} from "../entity-ids.js";
const HarnessName = Schema.Literals(["codex", "claude-code", "opencode", "devin"]);
const InstallDestination = Schema.Literals(["agents", "claude"]);
const InvocationPolicy = Schema.Literals(["explicit", "implicit", "host-policy"]);
const SourceRelativePath = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.length > 0 &&
      !value.startsWith("/") &&
      !/^[a-z]:\//i.test(value) &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
    { representation: { id: "skit/schema/source-relative-path", payload: null } },
  ),
);
type SourceRelativePath = typeof SourceRelativePath.Type;
const CollectionRelativePath = Schema.Union([Schema.Literal("."), SourceRelativePath]);
type CollectionRelativePath = typeof CollectionRelativePath.Type;
const HistoricalLocator = Schema.Struct({ value: Schema.String });
interface HistoricalLocator extends Schema.Schema.Type<typeof HistoricalLocator> {}
const BoundedOriginalEntry = Schema.JsonObject.check(
  Schema.makeFilter(
    (value) => new TextEncoder().encode(canonicalJson(value)).byteLength <= 65_536,
    {
      representation: { id: "skit/schema/skills-sh-original-limit", payload: { maxBytes: 65_536 } },
    },
  ),
);
const SourceIdentity = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("github"),
    owner: Schema.NonEmptyString,
    repository: Schema.NonEmptyString,
    collection_root: CollectionRelativePath,
  }),
  Schema.Struct({
    kind: Schema.Literal("git"),
    remote: HistoricalLocator,
    collection_root: CollectionRelativePath,
  }),
  Schema.Struct({
    kind: Schema.Literal("registry"),
    authority: Schema.NonEmptyString,
    namespace: Schema.NonEmptyString,
    slug: Schema.NonEmptyString,
  }),
  Schema.Struct({ kind: Schema.Literal("url"), url: HistoricalLocator }),
  Schema.Struct({ kind: Schema.Literal("archive"), url: HistoricalLocator }),
  Schema.Struct({
    kind: Schema.Literal("local"),
    machine_id: MachineId,
    path: HistoricalLocator,
  }),
  Schema.Struct({
    kind: Schema.Literal("authored-workspace"),
    workspace_id: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("well-known"),
    locator: HistoricalLocator,
  }),
]);
type SourceIdentity = typeof SourceIdentity.Type;
const SourceTracking = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("default") }),
  Schema.Struct({ kind: Schema.Literal("branch"), ref: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("tag"), ref: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("commit"), ref: Schema.NonEmptyString }),
]);
type SourceTracking = typeof SourceTracking.Type;
const Upstream = Schema.Struct({
  source_identity: SourceIdentity,
  tracking: SourceTracking,
});
type Upstream = typeof Upstream.Type;
const SkillsShLockFileEntry = Schema.Struct({
  type: Schema.Literal("skills.sh-lock"),
  machine_id: MachineId,
  read_at: Schema.String,
  source_updated_at: Schema.optionalKey(Schema.String),
  lock_path: HistoricalLocator,
  // oxlint-disable-next-line effecttsgo/schema-number -- Keep the released v11 reader frozen.
  lock_version: Schema.Number,
  lock_scope: Schema.Literals(["project", "global"]),
  lock_content_hash: Hash,
  source: Schema.String,
  source_type: Schema.String,
  source_url: Schema.optionalKey(Schema.String),
  source_base_url: Schema.optionalKey(Schema.String),
  ref: Schema.optionalKey(Schema.String),
  skill_name: Schema.String,
  skill_path: Schema.optionalKey(SourceRelativePath),
  computed_hash: Schema.optionalKey(Schema.String),
  skill_folder_hash: Schema.optionalKey(Schema.String),
  well_known_hash: Schema.optionalKey(Schema.String),
  content_agreement: Schema.Literals(["agrees", "mismatch", "unverifiable"]),
  original_entry_hash: Hash,
  original_entry: BoundedOriginalEntry,
  upstream_baseline: Schema.optionalKey(
    Schema.Struct({
      source_revision: Schema.String,
      skill_path: SourceRelativePath,
      tree_oid: Schema.String,
      lock_hash_kind: Schema.Literals(["computedHash", "skillFolderHash"]),
      lock_hash: Schema.String,
      verification: Schema.Literals(["lock-only", "lock+retained-bytes"]),
      established_at: Schema.String,
      search_scope: Schema.Literal("ref-path-history"),
    }),
  ),
});
interface SkillsShLockFileEntry extends Schema.Schema.Type<typeof SkillsShLockFileEntry> {}
const MaterializationProfile = Schema.Literals(["plain-skill/v1", "declared-skit-skill/v1"]);
type MaterializationProfile = typeof MaterializationProfile.Type;
const SkillVersion = Schema.Struct({
  skill_version_id: SkillVersionId,
  source_hash: Hash,
  artifact_hash: Hash,
  validation_identity_hash: Hash,
  materialization_profile: MaterializationProfile,
});
interface SkillVersion extends Schema.Schema.Type<typeof SkillVersion> {}
export const Skill = Schema.Struct({
  skill_id: SkillId,
  collection_id: CollectionId,
  path: CollectionRelativePath,
  name: Schema.NonEmptyString,
  /** A local edit the user retained; it is used until the Source changes this Skill. */
  local_version_id: Schema.mutableKey(Schema.optional(SkillVersionId)),
  versions: Schema.mutable(Schema.Array(SkillVersion)),
});
export interface Skill extends Schema.Schema.Type<typeof Skill> {}
export const Collection = Schema.Struct({
  collection_id: CollectionId,
  label: Schema.NonEmptyString,
  upstream: Schema.optionalKey(Upstream),
});
export interface Collection extends Schema.Schema.Type<typeof Collection> {}
const CollectionVersionSkill = Schema.Struct({
  source_path: CollectionRelativePath,
  source_hash: Hash,
  artifact_hash: Hash,
  materialization_profile: MaterializationProfile,
});
export const CollectionVersion = Schema.Struct({
  collection_version_id: CollectionVersionId,
  hash: Hash,
  copy_profile: Schema.Literal("verbatim/v1"),
  members: Schema.Array(CollectionVersionSkill),
});
export interface CollectionVersion extends Schema.Schema.Type<typeof CollectionVersion> {}
export const Import = Schema.Struct({
  import_id: ImportId,
  collection_id: CollectionId,
  kind: Schema.Literals(["source", "edit"]),
  collection_version_id: CollectionVersionId,
  source_identity: SourceIdentity,
  /** Where the bytes were read from, for provenance and display. Never parsed back. */
  input: HistoricalLocator,
  revision: Schema.optionalKey(Schema.NonEmptyString),
  imported_at: Schema.String,
  machine_id: MachineId,
  lock_file_entries: Schema.Array(SkillsShLockFileEntry),
});
export interface Import extends Schema.Schema.Type<typeof Import> {}
const gitObjectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const importCanBeRefetched = (sourceImport: Import): boolean => {
  if (sourceImport.kind !== "source" || sourceImport.revision === undefined) return false;
  switch (sourceImport.source_identity.kind) {
    case "github":
    case "git":
      return gitObjectId.test(sourceImport.revision);
    case "registry":
      return sourceImport.revision !== "latest";
    default:
      return false;
  }
};
const librarySnapshotDigests = (input: {
  readonly collection_versions: readonly CollectionVersion[];
  readonly imports: readonly Import[];
}): string[] =>
  [
    ...new Set(
      input.collection_versions
        .filter(
          (copy) =>
            !input.imports.some(
              (sourceImport) =>
                sourceImport.collection_version_id === copy.collection_version_id &&
                importCanBeRefetched(sourceImport),
            ),
        )
        .map((copy) => copy.hash),
    ),
  ].sort();
export const Enabled = Schema.Union([
  Schema.Struct({ collection: CollectionId }),
  Schema.Struct({ skill: SkillId }),
]);
export type Enabled = typeof Enabled.Type;
const sameEnabled = Schema.toEquivalence(Enabled);
interface LibraryEntities {
  readonly skills: readonly Skill[];
  readonly collection_versions: readonly CollectionVersion[];
  readonly imports: readonly Import[];
}
const collectionImports = (
  library: Pick<LibraryEntities, "imports">,
  collectionId: CollectionId,
): Import[] =>
  library.imports
    .filter((sourceImport) => sourceImport.collection_id === collectionId)
    .toSorted(
      (left, right) =>
        right.imported_at.localeCompare(left.imported_at) ||
        right.import_id.localeCompare(left.import_id),
    );
const sourceImports = (
  library: Pick<LibraryEntities, "imports">,
  collectionId: CollectionId,
): Import[] =>
  collectionImports(library, collectionId).filter((sourceImport) => sourceImport.kind === "source");
const currentCollectionSkills = (library: LibraryEntities, collectionId: CollectionId) => {
  const latest = sourceImports(library, collectionId)[0];
  const copy = library.collection_versions.find(
    (candidate) => candidate.collection_version_id === latest?.collection_version_id,
  );
  return library.skills.filter(
    (skill) =>
      skill.collection_id === collectionId &&
      copy?.members.some((member) => member.source_path === skill.path) === true,
  );
};
const versionBacking = (library: LibraryEntities, skill: Skill, version: SkillVersion) => {
  for (const sourceImport of collectionImports(library, skill.collection_id)) {
    const copy = library.collection_versions.find(
      (candidate) => candidate.collection_version_id === sourceImport.collection_version_id,
    );
    const path = sourceImport.kind === "source" ? skill.path : ".";
    const member = copy?.members.find((candidate) => candidate.source_path === path);
    if (
      copy !== undefined &&
      member !== undefined &&
      member.source_hash === version.source_hash &&
      member.artifact_hash === version.artifact_hash &&
      member.materialization_profile === version.materialization_profile
    )
      return { acquisition: sourceImport, copy, member };
  }
  return undefined;
};
const isNested = (left: string, right: string) =>
  left !== "." && right !== "." && (left.startsWith(`${right}/`) || right.startsWith(`${left}/`));
const CURRENT_PORTABLE_LIBRARY_SCHEMA = "skit.library.v8" as const;
const LibraryManifest = Schema.Struct({
  schema: Schema.Literal(CURRENT_PORTABLE_LIBRARY_SCHEMA),
  collections: Schema.Array(Collection),
  skills: Schema.Array(Skill),
  collection_versions: Schema.Array(CollectionVersion),
  imports: Schema.Array(Import),
  snapshot_digests: Schema.Array(Hash),
  /** What the account enables for every project. */
  enabled: Schema.Array(Enabled),
}).check(
  Schema.makeFilter((manifest) => {
    const repeated = (values: readonly string[]) => {
      const seen = new Set<string>();
      const duplicates = new Set<string>();
      for (const value of values) {
        if (seen.has(value)) duplicates.add(value);
        seen.add(value);
      }
      return [...duplicates];
    };
    const identifiers = [
      ["collections", manifest.collections.map((item) => item.collection_id)],
      ["skills", manifest.skills.map((item) => item.skill_id)],
      [
        "collection_versions",
        manifest.collection_versions.map((item) => item.collection_version_id),
      ],
      ["imports", manifest.imports.map((item) => item.import_id)],
      [
        "versions",
        manifest.skills.flatMap((skill) =>
          skill.versions.map((version) => version.skill_version_id),
        ),
      ],
    ] as const;
    for (const [entity, values] of identifiers) {
      const ids = repeated(values);
      if (ids.length)
        return manifestViolationIssue([entity === "versions" ? "skills" : entity], {
          _tag: "DuplicateIdentifiers",
          entity,
          ids,
        });
    }
    const collections = new Set(manifest.collections.map((item) => item.collection_id));
    const skills = new Set(manifest.skills.map((skill) => skill.skill_id));
    const copies = new Map(
      manifest.collection_versions.map((copy) => [copy.collection_version_id, copy]),
    );
    for (const collection of manifest.collections) {
      const subject = { collectionId: collection.collection_id, label: collection.label };
      const owned = manifest.skills.filter(
        (skill) => skill.collection_id === collection.collection_id,
      );
      const paths = owned.map((skill) => skill.path);
      const duplicatePaths = repeated(paths);
      if (duplicatePaths.length)
        return manifestViolationIssue(["skills"], {
          _tag: "DuplicateSkillPaths",
          ...subject,
          paths: duplicatePaths,
        });
      const names = currentCollectionSkills(manifest, collection.collection_id).map(
        (skill) => skill.name,
      );
      const duplicateNames = repeated(names);
      if (duplicateNames.length)
        return manifestViolationIssue(["skills"], {
          _tag: "DuplicateSkillNames",
          ...subject,
          names: duplicateNames,
        });
      for (const [index, left] of paths.entries()) {
        const right = paths.slice(index + 1).find((other) => isNested(left, other));
        if (right !== undefined)
          return manifestViolationIssue(["skills"], {
            _tag: "OverlappingSkillPaths",
            ...subject,
            left,
            right,
          });
      }
      if (paths.includes(".") && paths.length !== 1)
        return manifestViolationIssue(["skills"], {
          _tag: "RootSkillWithChildren",
          ...subject,
          paths,
        });
    }
    for (const [index, collection] of manifest.collections.entries()) {
      const upstream = collection.upstream;
      if (upstream === undefined) continue;
      const duplicate = manifest.collections
        .slice(index + 1)
        .find(
          (other) =>
            other.upstream !== undefined &&
            Schema.toEquivalence(Upstream)(upstream, other.upstream),
        );
      if (duplicate !== undefined)
        return manifestViolationIssue(["collections"], {
          _tag: "DuplicateUpstream",
          first: { collectionId: collection.collection_id, label: collection.label },
          second: { collectionId: duplicate.collection_id, label: duplicate.label },
        });
    }
    for (const acquisition of manifest.imports) {
      if (!collections.has(acquisition.collection_id))
        return manifestViolationIssue(["imports"], {
          _tag: "ImportCollectionMissing",
          importId: acquisition.import_id,
          collectionId: acquisition.collection_id,
        });
      if (!copies.has(acquisition.collection_version_id))
        return manifestViolationIssue(["imports"], {
          _tag: "ImportCopyMissing",
          importId: acquisition.import_id,
          copyId: acquisition.collection_version_id,
        });
    }
    for (const copy of manifest.collection_versions) {
      if (copy.members.length === 0)
        return manifestViolationIssue(["collection_versions"], {
          _tag: "CopyMembersEmpty",
          copyId: copy.collection_version_id,
        });
      const paths = repeated(copy.members.map((member) => member.source_path));
      if (paths.length)
        return manifestViolationIssue(["collection_versions"], {
          _tag: "CopyMemberPathsDuplicate",
          copyId: copy.collection_version_id,
          paths,
        });
      if (
        !manifest.imports.some(
          (acquisition) => acquisition.collection_version_id === copy.collection_version_id,
        )
      )
        return manifestViolationIssue(["collection_versions"], {
          _tag: "CopyImportMissing",
          copyId: copy.collection_version_id,
        });
    }
    for (const skill of manifest.skills) {
      const subject = { skillId: skill.skill_id, name: skill.name };
      if (!collections.has(skill.collection_id))
        return manifestViolationIssue(["skills"], {
          _tag: "SkillCollectionMissing",
          ...subject,
          collectionId: skill.collection_id,
        });
      if (
        skill.local_version_id !== undefined &&
        !skill.versions.some((version) => version.skill_version_id === skill.local_version_id)
      )
        return manifestViolationIssue(["skills"], {
          _tag: "SkillVersionMissing",
          ...subject,
          versionId: skill.local_version_id,
        });
      for (const version of skill.versions) {
        const matching = skill.versions.filter(
          (other) => other.artifact_hash === version.artifact_hash,
        );
        if (matching.length !== 1)
          return manifestViolationIssue(["skills"], {
            _tag: "ArtifactVersionsDuplicate",
            ...subject,
            hash: version.artifact_hash,
            versionIds: matching.map((item) => item.skill_version_id),
          });
        if (versionBacking(manifest, skill, version) === undefined)
          return manifestViolationIssue(["skills"], {
            _tag: "VersionBackingMissing",
            ...subject,
            versionId: version.skill_version_id,
          });
      }
    }
    const duplicateDigests = repeated(manifest.snapshot_digests);
    if (duplicateDigests.length)
      return manifestViolationIssue(["snapshot_digests"], {
        _tag: "CollectionVersionHashesDuplicate",
        digests: manifest.snapshot_digests.filter((digest) => duplicateDigests.includes(digest)),
      });
    const expected = librarySnapshotDigests(manifest);
    if (
      !Schema.toEquivalence(Schema.Array(Schema.String))(
        [...manifest.snapshot_digests].sort(),
        expected,
      )
    )
      return manifestViolationIssue(["snapshot_digests"], {
        _tag: "CollectionVersionHashesMismatch",
        expected,
        actual: manifest.snapshot_digests,
      });
    for (const [index, item] of manifest.enabled.entries()) {
      const reference =
        "collection" in item
          ? { kind: "collection" as const, id: item.collection }
          : { kind: "skill" as const, id: item.skill };
      if (manifest.enabled.slice(index + 1).some((other) => sameEnabled(item, other)))
        return manifestViolationIssue(["enabled"], { _tag: "EnabledDuplicate", ...reference });
      if ("collection" in item ? !collections.has(item.collection) : !skills.has(item.skill))
        return manifestViolationIssue(["enabled"], { _tag: "EnabledSubjectMissing", ...reference });
    }
    return true;
  }),
);
interface LibraryManifest extends Schema.Schema.Type<typeof LibraryManifest> {}
const AbsoluteDevicePath = Schema.String.check(
  Schema.makeFilter(isAbsolute, {
    representation: { id: "skit/schema/path-absolute", payload: null },
  }),
);
type AbsoluteDevicePath = typeof AbsoluteDevicePath.Type;
const InvocationPolicies = Schema.Record(SkillId, InvocationPolicy);
type InvocationPolicies = typeof InvocationPolicies.Type;
export const Repository = Schema.Struct({
  root: AbsoluteDevicePath,
  enabled: Schema.Array(Enabled),
  invocation_policies: Schema.optionalKey(InvocationPolicies),
});
export interface Repository extends Schema.Schema.Type<typeof Repository> {}
const InstalledSkillFields = {
  installed_skill_id: InstalledSkillId,
  skill_id: SkillId,
  skill_version_id: SkillVersionId,
  destination: InstallDestination,
  root: AbsoluteDevicePath,
  path: AbsoluteDevicePath,
  /** The hash of the folder SKIT wrote. */
  expected_hash: Hash,
  installed_at: Schema.String,
} as const;
const InstalledSkillInstalled = Schema.Struct({
  ...InstalledSkillFields,
  status: Schema.Literal("installed"),
});
interface InstalledSkillInstalled extends Schema.Schema.Type<typeof InstalledSkillInstalled> {}
const InstalledSkillPending = Schema.Struct({
  ...InstalledSkillFields,
  status: Schema.Literal("pending"),
});
interface InstalledSkillPending extends Schema.Schema.Type<typeof InstalledSkillPending> {}
const InstalledSkillConflicted = Schema.Struct({
  ...InstalledSkillFields,
  status: Schema.Literal("conflicted"),
  current_hash: Hash,
});
interface InstalledSkillConflicted extends Schema.Schema.Type<typeof InstalledSkillConflicted> {}
const InstalledSkillSuppressed = Schema.Struct({
  ...InstalledSkillFields,
  status: Schema.Literal("suppressed"),
  suppression_reason: Schema.Literal("native_delete"),
  suppressed_at: Schema.optionalKey(Schema.String),
});
interface InstalledSkillSuppressed extends Schema.Schema.Type<typeof InstalledSkillSuppressed> {}
export const InstalledSkill = Schema.Union([
  InstalledSkillInstalled,
  InstalledSkillPending,
  InstalledSkillConflicted,
  InstalledSkillSuppressed,
]);
export type InstalledSkill =
  | InstalledSkillInstalled
  | InstalledSkillPending
  | InstalledSkillConflicted
  | InstalledSkillSuppressed;
export const DeviceSkillSelection = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("follow-account") }),
  Schema.Struct({
    mode: Schema.Literal("choose"),
    enabled: Schema.Array(Enabled),
    invocation_policies: Schema.optionalKey(InvocationPolicies),
  }),
]);
export type DeviceSkillSelection = typeof DeviceSkillSelection.Type;
export const SkillAssessmentAcceptance = Schema.Struct({
  fingerprint: Hash,
  artifactContentHash: Hash,
  skill_version_id: SkillVersionId,
  context: Schema.Literal("project"),
  principal: Schema.String,
  rationale: Schema.String,
  acceptedAt: Schema.String,
  expiresAt: Schema.optionalKey(Schema.String),
});
export type SkillAssessmentAcceptance = typeof SkillAssessmentAcceptance.Type;
export const OwnershipIssue = Schema.Struct({
  code: Schema.Literals(["ORPHANED_OWNERSHIP_MARKER", "INVALID_OWNERSHIP_MARKER"]),
  path: Schema.String,
  canonicalPath: Schema.String,
  harnesses: Schema.mutable(Schema.Array(HarnessName)),
  currentHash: Hash,
  detail: Schema.optional(Schema.String),
  collectionId: Schema.optional(CollectionId),
  skillId: Schema.optional(SkillId),
  installedSkillId: Schema.optional(InstalledSkillId),
  expectedHash: Schema.optional(Hash),
  matchesExpectedHash: Schema.optional(Schema.Boolean),
});
export type OwnershipIssue = typeof OwnershipIssue.Type;
export const InventoryScanIssue = Schema.Union([
  Schema.Struct({
    path: Schema.String,
    harness: HarnessName,
    code: Schema.Literal("MISSING_ROOT"),
  }),
  Schema.Struct({
    path: Schema.String,
    harness: HarnessName,
    code: Schema.Literal("UNREADABLE_PATH"),
  }),
  Schema.Struct({
    path: Schema.String,
    target: Schema.String,
    harness: HarnessName,
    code: Schema.Literal("DANGLING_SYMLINK"),
  }),
]);
export type InventoryScanIssue = typeof InventoryScanIssue.Type;
export const SyncAncestry = Schema.Struct({
  origin: Schema.NonEmptyString,
  library_id: Schema.NonEmptyString,
  revision_id: Schema.NonEmptyString,
  base_manifest: LibraryManifest,
});
export interface SyncAncestry extends Schema.Schema.Type<typeof SyncAncestry> {}
