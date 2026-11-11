import type {
  InvocationConformanceIssue,
  PublicationDiagnostic,
  SkitValidationDiagnostic,
} from "@smolai/skit-core/universal/consumer";
import { Match } from "effect";
import { descriptorIssue } from "./descriptor-issue";

const nativeValue = (
  harness: InvocationConformanceIssue["harness"],
  policy: "implicit" | "explicit",
) =>
  Match.value(harness).pipe(
    Match.when("claude-code", () => String(policy === "explicit")),
    Match.when("codex", () => String(policy === "implicit")),
    Match.when("opencode", () => `"${policy === "implicit"}"`),
    Match.when("devin", () => (policy === "implicit" ? "[user, model]" : "[user]")),
    Match.exhaustive,
  );

const invocationConformanceIssue = (issue: InvocationConformanceIssue): string => {
  const requirement =
    issue.expected === undefined
      ? `must not set ${issue.field}`
      : `must set ${issue.field}: ${nativeValue(issue.harness, issue.expected)}`;
  const found =
    issue.actual === undefined
      ? "the field is absent"
      : `found ${nativeValue(issue.harness, issue.actual)}`;
  return `${issue.skill} declares invocation ${issue.policy}, so its ${issue.harness} metadata ${issue.path} ${requirement} (${found}); run \`skit author invocation\` to write it`;
};

export const validationDiagnostic = Match.type<SkitValidationDiagnostic>().pipe(
  Match.discriminatorsExhaustive("code")({
    SKILL_FILE_MISSING: () => "Contained skills require a primary SKILL.md",
    SHARED_SOURCE_MISSING: ({ skill }) => `Shared mapping source for ${skill} does not exist`,
    SHARED_TARGET_TRAVERSAL: () => "Shared mapping target escapes the child skill",
    SECURITY_POLICY_BLOCKED: ({ assessment }) =>
      `Security assessment ${assessment.outcome}: ${assessment.reasons.map((reason) => reason.code).join(", ")}`,
    SECURITY_ASSESSMENT_WARNING: ({ assessment }) =>
      `Security assessment ${assessment.outcome}: ${assessment.reasons.map((reason) => reason.code).join(", ")}`,
    INVOCATION_METADATA_MISMATCH: ({ issue }) => invocationConformanceIssue(issue),
    CAPABILITY_PATH_MISSING: () => "Declared capability path does not exist",
    EXAMPLE_MANIFEST_INVALID: ({ reason }) =>
      reason._tag === "Unreadable" ? reason.failure.message : descriptorIssue(reason.issue),
    EXAMPLE_PATH_IDENTITY_MISMATCH: () =>
      "Example skill and id must match examples/<skill>/<id>/case.yaml",
    EXAMPLE_SKILL_UNKNOWN: ({ skill }) => `Example references undeclared skill ${skill}`,
    EXAMPLE_ID_DUPLICATE: ({ skill, id }) => `Duplicate example identity ${skill}:${id}`,
    EXAMPLE_PROMPT_MISSING: () => "Example prompt does not exist",
    EXAMPLE_FIXTURE_MISSING: () => "Example fixture does not exist",
    EXAMPLE_SCREENSHOT_MISSING: () => "Example screenshot does not exist",
    EXAMPLE_SCREENSHOT_MEDIA_INVALID: () => "Example screenshot must use an image media type",
  }),
);

export const publicationDiagnostic = (diagnostic: PublicationDiagnostic): string =>
  "_tag" in diagnostic ? diagnostic.message : validationDiagnostic(diagnostic);
