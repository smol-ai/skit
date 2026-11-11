import {
  DescriptorFailure,
  SkillDiscoveryLimitExceeded,
  SkillNameInvalid,
  SkitValidationFailed,
} from "@smolai/skit-core/universal/consumer";
import { HarnessMetadataInvalid } from "@smolai/skit-core/harnesses";
import { Match, Schema } from "effect";
import { descriptorIssue } from "./descriptor-issue";
import { validationDiagnostic } from "./validation-diagnostic";

export const ArtifactFailure = Schema.Union([
  DescriptorFailure,
  SkillDiscoveryLimitExceeded,
  SkillNameInvalid,
  SkitValidationFailed,
  HarnessMetadataInvalid,
]);

/** Artifact facts have the same explanation whether opening a preference or importing a source. */
export const artifactFailure = Match.type<typeof ArtifactFailure.Type>().pipe(
  Match.tagsExhaustive({
    DuplicateSkillNames: () => "Contained skill names must be unique within a SKIT",
    DuplicateSkillPaths: () => "Contained skill paths must be unique within a SKIT",
    ConflictingInvocationDeclaration: ({ skill }) =>
      `${skill} declares conflicting invocation and trigger_modes values`,
    ReadmeFrontmatterMissing: () => "README.md must begin with YAML frontmatter",
    DescriptorMalformed: ({ format, issue }) =>
      `Malformed ${format.toUpperCase()} SKIT Descriptor: ${descriptorIssue(issue)}`,
    HarnessMetadataInvalid: ({ kind, path }) => `Invalid ${kind}: ${path}`,
    SkillDiscoveryLimitExceeded: ({ limit }) =>
      `Skill discovery exceeded the directory limit (${limit}). Choose the directory that holds the Skills.`,
    SkillNameInvalid: ({ path }) =>
      `${path} must declare a lowercase, hyphenated Skill name in its frontmatter`,
    SkitValidationFailed: ({ diagnostics }) =>
      [
        "SKIT validation failed",
        ...diagnostics.map(
          (diagnostic) => `${diagnostic.path}: ${validationDiagnostic(diagnostic)}`,
        ),
        "Correct the reported diagnostics in the source, then retry.",
      ].join("\n"),
  }),
);
