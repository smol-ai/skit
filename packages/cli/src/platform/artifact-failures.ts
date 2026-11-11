import { describeFailure } from "../terminal/failure.js";
import { Block } from "../terminal/blocks.js";
import { validationDiagnostic } from "./validation-diagnostic.js";
import { descriptorIssue } from "./descriptor-issue.js";
import {
  DescriptorFailure,
  SkillDiscoveryLimitExceeded,
  SkillNameInvalid,
  SkitValidationFailed,
} from "@smolai/skit-core/universal/consumer";
import { HarnessMetadataInvalid } from "@smolai/skit-core/harnesses";
import { Match, Schema } from "effect";

export const ArtifactDataFailure = Schema.Union([
  DescriptorFailure,
  SkillDiscoveryLimitExceeded,
  SkillNameInvalid,
  SkitValidationFailed,
  HarnessMetadataInvalid,
]);

export const artifactFailure = Match.type<typeof ArtifactDataFailure.Type>().pipe(
  Match.tagsExhaustive({
    DuplicateSkillNames: () =>
      describeFailure({
        summary: ["Contained skill names must be unique within a SKIT"],
        next: ["Give each contained Skill a unique name in the SKIT Descriptor, then retry."],
      }),
    DuplicateSkillPaths: () =>
      describeFailure({
        summary: ["Contained skill paths must be unique within a SKIT"],
        next: ["List each contained Skill path once in the SKIT Descriptor, then retry."],
      }),
    ConflictingInvocationDeclaration: ({ skill }) =>
      describeFailure({
        summary: [`${skill} declares conflicting invocation and trigger_modes values`],
        next: ["Make the invocation and trigger_modes values for " + skill + " agree, then retry."],
      }),
    ReadmeFrontmatterMissing: () =>
      describeFailure({
        summary: ["README.md must begin with YAML frontmatter"],
        next: ["Begin the source's README.md with YAML frontmatter, then retry."],
      }),
    DescriptorMalformed: ({ format, issue }) =>
      describeFailure({
        summary: [`Malformed ${format.toUpperCase()} SKIT Descriptor: ${descriptorIssue(issue)}`],
        next: ["Correct the SKIT Descriptor in the source, then retry."],
      }),
    SkillDiscoveryLimitExceeded: () =>
      describeFailure({
        summary: ["Skill discovery exceeded directory limit"],
        next: [
          "Choose the directory that holds the Skills, rather than a larger tree, then retry.",
        ],
      }),
    SkillNameInvalid: ({ path }) =>
      describeFailure({
        summary: [`${path} must declare a valid name`],
        next: ["Give " + path + " a lowercase, hyphenated name in its frontmatter, then retry."],
      }),
    SkitValidationFailed: ({ diagnostics }) =>
      describeFailure({
        summary: ["SKIT validation failed"],
        details: [
          Block.List({
            items: diagnostics.map((diagnostic) => ({
              text: [validationDiagnostic(diagnostic)],
              detail: [{ path: diagnostic.path }],
            })),
          }),
        ],
        next: ["Correct the reported diagnostics in the source, then retry."],
      }),
    HarnessMetadataInvalid: ({ kind, path }) =>
      describeFailure({
        summary: [`Invalid ${kind}: ${path}`],
        next: ["Correct the YAML in " + path + ", then retry."],
      }),
  }),
);
