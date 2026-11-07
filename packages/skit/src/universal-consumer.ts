// Runtime-agnostic contracts and Artifact behavior required by Registry consumer capabilities.
// The Registry Worker imports this entry, so nothing reachable from it may touch the Node platform
// layer (`platform/layer.ts`, `platform/link-stat.ts`, `@effect/platform-node`, or `node:fs`).
// `lint/universal-entry.test.ts` walks the import graph to keep that true.
export { BuildInfo } from "./shared/build-info.js";
export { serverDiscoverySchema, type ServerDiscovery } from "./api/consumer-contracts.js";
export {
  LibraryManifest,
  RemoteLibrary,
  LibraryWriteRequest,
  SnapshotArchive,
} from "./library/library-contracts.js";
export { StoredLibraryManifest } from "./library/store/stored-manifest.js";
export {
  CollectionId,
  SkillId,
  SkillVersionId,
  CollectionVersionId,
  ImportId,
  InstalledSkillId,
  MachineId,
  OperationId,
  makeCollectionId,
  makeSkillId,
  makeSkillVersionId,
  makeCollectionVersionId,
  makeImportId,
  makeInstalledSkillId,
  makeMachineId,
  makeOperationId,
} from "./library/entity-ids.js";
export {
  SnapshotArchiveInvalid,
  verifySnapshotArchive,
} from "./library/snapshot-archive-universal.js";
export { auditSkill, evaluateSkillAudit } from "./auditing/skill-audit.js";

export {
  type RegistrySkitDescriptor,
  type ValidatedSkit,
  type SkitReleaseIdentity,
} from "./artifact/contracts.js";

export { Hash } from "./shared/hash.js";

export {
  normalizeDescriptorDeclarations,
  projectSkillFiles,
  projectionIndex,
  measureSkillProjection,
  installedSkillHashParts,
  parseSkitReadme,
  parseSkitConfig,
  type InstalledSkillFile,
} from "./artifact/descriptor.js";

export {
  type DuplicateSkillNames,
  type DuplicateSkillPaths,
  type ConflictingInvocationDeclaration,
  type SkillDiscoveryLimitExceeded,
  type SkillNameInvalid,
} from "./artifact/failures.js";
export {
  type SourceRequired,
  type UnsafeSourceUrl,
  type InsecureSourceUrl,
  type ArchiveEntryLimitExceeded,
  type UnsafeArchivePath,
  type SourceNotFound,
  type UnsafeGitSubpath,
  type GitSourceFragment,
} from "./sources/failures.js";
export {
  type UnsafeInstalledSkillName,
  type UnsafeInstalledSkillBackups,
  type SharedTargetCollision,
  type InstalledPathCollision,
  type NoSkillsDirectory,
  type OwnershipMarkerDisagrees,
  type ManageTargetChanged,
  type ManageContentMismatch,
  type UninstallConflict,
} from "./installed-skills/failures.js";
export {
  type ContentAddressCollision,
  type UnknownInstalledSkill,
  type SecurityFindingAbsent,
  type AcceptanceIncomplete,
  type LibraryChanged,
} from "./library/failures.js";
export { type HomeBusy } from "./platform/lock-failures.js";

export { type RegistryNotConfigured } from "./shared/input-failures.js";

export { parseSkillFrontmatter } from "./harnesses/frontmatter.js";
export {
  assessInvocationConformance,
  describeInvocationConformanceIssue,
} from "./invocation/conformance.js";
export { canonicalJson } from "./shared/json.js";
export { encodeHashParts, sha256Hash } from "./shared/hash.js";
export { normalizeRegistryNamespace } from "./artifact/registry-identity.js";
export { safePathSchema, type SharedMapping } from "./artifact/schemas.js";
