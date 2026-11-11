import { Schema } from "effect";
import { SkillAssessmentDecision } from "../auditing/skill-contracts.js";
import { InvocationConformanceIssue } from "../invocation/conformance-issue.js";
import { PlatformErrorSchema } from "../platform/error-schema.js";
import { DescriptorIssue } from "./descriptor-issue.js";

const fields = {
  severity: Schema.Literals(["info", "warning", "error"]),
  path: Schema.String,
};
const diagnostic = <const C extends string, F extends Schema.Struct.Fields>(code: C, facts: F) =>
  Schema.Struct({ code: Schema.Literal(code), ...fields, ...facts });

export const SkitValidationDiagnostic = Schema.Union([
  diagnostic("SKILL_FILE_MISSING", {}),
  diagnostic("SHARED_SOURCE_MISSING", { skill: Schema.String }),
  diagnostic("SHARED_TARGET_TRAVERSAL", {}),
  diagnostic("SECURITY_POLICY_BLOCKED", { assessment: SkillAssessmentDecision }),
  diagnostic("SECURITY_ASSESSMENT_WARNING", { assessment: SkillAssessmentDecision }),
  diagnostic("INVOCATION_METADATA_MISMATCH", { issue: InvocationConformanceIssue }),
  diagnostic("CAPABILITY_PATH_MISSING", {}),
  diagnostic("EXAMPLE_MANIFEST_INVALID", {
    reason: Schema.Union([
      Schema.TaggedStruct("Unreadable", { failure: PlatformErrorSchema }),
      Schema.TaggedStruct("Malformed", { issue: DescriptorIssue }),
    ]),
  }),
  diagnostic("EXAMPLE_PATH_IDENTITY_MISMATCH", {
    skill: Schema.String,
    id: Schema.String,
    directorySkill: Schema.String,
    directoryId: Schema.String,
  }),
  diagnostic("EXAMPLE_SKILL_UNKNOWN", { skill: Schema.String }),
  diagnostic("EXAMPLE_ID_DUPLICATE", { skill: Schema.String, id: Schema.String }),
  diagnostic("EXAMPLE_PROMPT_MISSING", {}),
  diagnostic("EXAMPLE_FIXTURE_MISSING", {}),
  diagnostic("EXAMPLE_SCREENSHOT_MISSING", {}),
  diagnostic("EXAMPLE_SCREENSHOT_MEDIA_INVALID", { mediaType: Schema.String }),
]);
export type SkitValidationDiagnostic = typeof SkitValidationDiagnostic.Type;

/** A Registry diagnostic is external evidence; its wording belongs to that Registry. */
const RegistryValidationDiagnostic = Schema.TaggedStruct("RegistryDiagnostic", {
  code: Schema.String,
  severity: Schema.Literals(["info", "warning", "error"]),
  message: Schema.String,
  path: Schema.optionalKey(Schema.String),
});
export const PublicationDiagnostic = Schema.Union([
  RegistryValidationDiagnostic,
  SkitValidationDiagnostic,
]);
export type PublicationDiagnostic = typeof PublicationDiagnostic.Type;
