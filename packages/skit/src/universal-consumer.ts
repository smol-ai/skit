// Runtime-agnostic contracts and Artifact behavior required by Registry consumer capabilities.
// The Registry Worker imports this entry, so nothing reachable from it may touch the Node platform
// layer (`platform/layer.ts`, `platform/link-stat.ts`, `@effect/platform-node`, or `node:fs`).
// `lint/universal-entry.test.ts` walks the import graph to keep that true.
export * from "./shared/build-info.js";
export * from "./api/consumer-contracts.js";
export * from "./library/library-contracts.js";
export { StoredLibraryManifest } from "./library/store/stored-manifest.js";
export * from "./library/entity-ids.js";
export * from "./library/snapshot-archive-universal.js";
export * from "./auditing/skill-audit.js";
export { LibraryInvocationOption } from "./library/invocation-option.js";
export {
  type RegistrySkitDescriptor,
  type SkitFileRecord,
  type SyncConflict,
  type SkillExampleRecord,
  type ValidatedSkit,
  type SkitReleaseIdentity,
} from "./artifact/contracts.js";
export { OwnershipMarker } from "./installed-skills/ownership-marker.js";
export {
  SkillAuditFinding,
  SkillAudit,
  SkillAssessmentContext,
  SkillAssessmentOutcome,
  SkillAssessmentReason,
  SkillAcceptanceReviewRecord,
  SkillFindingDecision,
  SkillAssessmentDecision,
  SkillSecurityReview,
} from "./auditing/skill-contracts.js";
export { Hash } from "./shared/hash.js";
export { HarnessName } from "./harnesses/contracts.js";
export { InvocationPolicy } from "./artifact/invocation-policy.js";
export { InstallDestination } from "./installed-skills/destination.js";
export { InstallScope } from "./library/scope.js";
export { SkitValidationDiagnostic } from "./artifact/validation-diagnostic.js";
export { SkillAssessmentAcceptance } from "./library/assessment-acceptance.js";
export { type HarnessInstallStatus, type OwnershipIssue } from "./installed-skills/metadata.js";
export * from "./artifact/descriptor.js";
export * from "./shared/failure.js";
export {
  DuplicateSkillNames,
  DuplicateSkillPaths,
  ConflictingInvocationDeclaration,
  ReadmeFrontmatterMissing,
  DescriptorMalformed,
  SkillDiscoveryLimitExceeded,
  SkillNameInvalid,
  SkitValidationFailed,
  type DescriptorFailure,
} from "./artifact/failures.js";
export {
  SourceRequired,
  UnsafeSourceUrl,
  InsecureSourceUrl,
  ArchiveEntryLimitExceeded,
  UnsafeArchivePath,
  SourceNotFound,
  UnsafeGitSubpath,
  GitSourceFragment,
  DirectSkillDocumentInvalid,
  NoSkitDescriptorFound,
} from "./sources/failures.js";
export {
  UnsafeInstalledSkillName,
  UnsafeInstalledSkillBackups,
  SharedTargetCollision,
  InstalledPathCollision,
  NoSkillsDirectory,
  SkillsDirectoryNotWritable,
  OwnershipMarkerDisagrees,
  ManageTargetChanged,
  ManageContentMismatch,
  InstalledSkillFileMissing,
  UninstallConflict,
} from "./installed-skills/failures.js";
export {
  ContentAddressCollision,
  UnknownInstalledSkill,
  SecurityFindingAbsent,
  AcceptanceIncomplete,
  ImportContentInvalid,
  InvalidLibraryState,
  LibraryChanged,
} from "./library/failures.js";
export { HomeBusy } from "./platform/lock-failures.js";
export { NotAnAuthorWorkspace } from "./author/failures.js";
export { HarnessMetadataInvalid } from "./harnesses/metadata-failures.js";
export { RegistryNotConfigured } from "./shared/input-failures.js";
export * from "./harnesses/contracts.js";
export * from "./harnesses/frontmatter.js";
export * from "./invocation/conformance.js";
export * from "./shared/json.js";
export * from "./shared/hash.js";
export * from "./artifact/registry-identity.js";
export {
  SKIT_DESCRIPTOR_VERSION,
  SKILL_EXAMPLE_SCHEMA_VERSION,
  hashSchema,
  safePathSchema,
  kebabNameSchema,
  registryNamespaceSchema,
  registrySkitSlugSchema,
  registrySkitIdSchema,
  sharedMappingSchema,
  type SharedMapping,
  skitValidationDiagnosticSchema,
  containedSkillSchema,
  type ContainedSkillDescriptor,
  skitConfigSchema,
  skillExampleSchema,
  type SkillExampleManifest,
  skitDescriptorWireSchema,
  type SkitWireDescriptor,
  skitDescriptorSchema,
  type SkitDescriptor,
} from "./artifact/schemas.js";
