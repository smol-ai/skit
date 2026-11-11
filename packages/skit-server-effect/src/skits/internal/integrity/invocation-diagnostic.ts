import type { InvocationConformanceIssue } from "@smolai/skit-core/universal/consumer";
import { Match } from "effect";

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

export const invocationConformanceIssue = (issue: InvocationConformanceIssue): string => {
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
