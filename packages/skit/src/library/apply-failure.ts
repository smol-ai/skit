import { Schema } from "effect";
import { PlatformErrorSchema } from "../platform/error-schema.js";
import { InvalidLibraryState, LibraryChanged } from "./failures.js";
import { InvalidIntent, SetEnabledInvalid } from "./enabled-plan.js";
import {
  StalePlan,
  DestinationsIncomplete,
  InstalledSkillWouldDuplicate,
  InstalledSkillWouldReplaceLink,
} from "./plan-failures.js";
import { CollectionRemovalMissing } from "./installation/remove.js";
import { InstalledSkillInvalid } from "./installation/install-enabled.js";
import {
  SkillsDirectoryNotWritable,
  UnsafeInstalledSkillName,
  OwnershipMarkerDisagrees,
  UninstallConflict,
  UnsafeInstalledSkillBackups,
  InstalledSkillFileMissing,
  SharedTargetCollision,
  InstalledPathCollision,
} from "../installed-skills/failures.js";
import { InstalledSkillFailure } from "../installed-skills/files.js";
import { HarnessMetadataInvalid } from "../harnesses/metadata-failures.js";
import { TreeError } from "../shared/tree-error.js";
import { DuplicateScanIncomplete } from "./installed-skill-facts.js";
import {
  DescriptorMalformed,
  DuplicateSkillNames,
  DuplicateSkillPaths,
  ConflictingInvocationDeclaration,
  ReadmeFrontmatterMissing,
} from "../artifact/failures.js";
import { HomeBusy } from "../platform/lock-failures.js";

/** Every checked failure applying a reviewed installed-skill plan can return. */
export const ApplyFailure = Schema.Union([
  PlatformErrorSchema,
  InvalidLibraryState,
  InvalidIntent,
  SetEnabledInvalid,
  StalePlan,
  CollectionRemovalMissing,
  InstalledSkillInvalid,
  InstalledSkillFailure,
  SkillsDirectoryNotWritable,
  UnsafeInstalledSkillName,
  OwnershipMarkerDisagrees,
  UninstallConflict,
  UnsafeInstalledSkillBackups,
  HarnessMetadataInvalid,
  InstalledSkillFileMissing,
  TreeError,
  DuplicateScanIncomplete,
  DescriptorMalformed,
  DuplicateSkillNames,
  DuplicateSkillPaths,
  ConflictingInvocationDeclaration,
  ReadmeFrontmatterMissing,
  DestinationsIncomplete,
  InstalledSkillWouldDuplicate,
  InstalledSkillWouldReplaceLink,
  SharedTargetCollision,
  InstalledPathCollision,
  HomeBusy,
  LibraryChanged,
]).annotate({ identifier: "ApplyFailure" });
export type ApplyFailure = typeof ApplyFailure.Type;
