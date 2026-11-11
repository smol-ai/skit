import { Schema } from "effect";
import { DescriptorFailure } from "../artifact/failures.js";
import { SkitValidationDiagnostic } from "../artifact/validation-diagnostic.js";
import { FrontmatterCompatibilityResult } from "../harnesses/frontmatter.js";
import { PlatformErrorSchema } from "../platform/error-schema.js";
import {
  UninstallConflict,
  SharedTargetCollision,
  InstalledPathCollision,
} from "../installed-skills/failures.js";
import { SharedMappingInvalid } from "./failures.js";
import { TreeError } from "../shared/tree-error.js";
import { HarnessMetadataInvalid } from "../harnesses/metadata-failures.js";
import { ApplyFailure } from "./apply-failure.js";

const preparationFailure = Schema.Union([
  DescriptorFailure,
  PlatformErrorSchema,
  TreeError,
  HarnessMetadataInvalid,
  SharedTargetCollision,
  InstalledPathCollision,
  SharedMappingInvalid,
]);

/** Why Author inputs or installed copies were left in place. No warning text crosses this owner. */
export const AuthoredSkillIssue = Schema.TaggedUnion({
  DescriptorHeld: { failure: Schema.Union([DescriptorFailure, PlatformErrorSchema]) },
  ReservedInputPath: { path: Schema.String },
  MembershipRemovalPending: { skill: Schema.String, path: Schema.String },
  InputRemovalPending: { skill: Schema.String, paths: Schema.Array(Schema.String) },
  ValidationHeld: { skill: Schema.String, diagnostics: Schema.Array(SkitValidationDiagnostic) },
  MetadataHeld: { skill: Schema.String, reports: Schema.Array(FrontmatterCompatibilityResult) },
  PreparationFailed: { skill: Schema.String, failure: preparationFailure },
  UninstallBlocked: { skill: Schema.String, failure: UninstallConflict },
  CopyFailed: { skill: Schema.String, path: Schema.String, failure: ApplyFailure },
  CopyConflicted: { skill: Schema.String, path: Schema.String },
  CopyPending: { skill: Schema.String, path: Schema.String },
  InstallationFailed: {
    skill: Schema.String,
    paths: Schema.Array(Schema.String),
    failure: ApplyFailure,
  },
}).annotate({ identifier: "AuthoredSkillIssue" });
export type AuthoredSkillIssue = typeof AuthoredSkillIssue.Type;
