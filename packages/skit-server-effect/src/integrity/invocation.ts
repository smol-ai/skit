import { Effect } from "effect";
import { parseDocument } from "yaml";
import type { ContainedSkill, InvocationPolicy } from "./contracts.js";
import { IntegrityError } from "./contracts.js";

const FRONTMATTER = /^---\r?\n([\s\S]*?)^---(?=\r?\n|$)/m;

export interface InvocationConformanceIssue {
  readonly skill: string;
  readonly harness: "claude-code" | "codex";
  readonly path: string;
  readonly field: string;
  readonly policy: InvocationPolicy;
  readonly expected: boolean | undefined;
  readonly actual: boolean | undefined;
}

const joinPath = (left: string, right: string): string =>
  `${left}/${right}`
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");

const expectedNativeInvocation = (
  harness: InvocationConformanceIssue["harness"],
  policy: InvocationPolicy,
): boolean | undefined => {
  if (policy === "host-policy") return undefined;
  return harness === "claude-code" ? policy === "explicit" : policy === "implicit";
};

const readClaude = (text: string | undefined, path: string) => {
  if (text === undefined) return Effect.succeed<boolean | undefined>(undefined);
  const match = text.match(FRONTMATTER);
  if (!match) return Effect.succeed<boolean | undefined>(undefined);
  const document = parseDocument(match[1]);
  if (document.errors.length > 0)
    return Effect.fail(new IntegrityError({ code: "INVALID_INVOCATION_METADATA", detail: path }));
  const value = document.get("disable-model-invocation");
  return Effect.succeed(typeof value === "boolean" ? value : undefined);
};

const readCodex = (text: string | undefined, path: string) => {
  if (text === undefined) return Effect.succeed<boolean | undefined>(undefined);
  const document = parseDocument(text);
  if (document.errors.length > 0)
    return Effect.fail(new IntegrityError({ code: "INVALID_INVOCATION_METADATA", detail: path }));
  const value = document.getIn(["policy", "allow_implicit_invocation"]);
  return Effect.succeed(typeof value === "boolean" ? value : undefined);
};

const ADAPTERS = [
  {
    harness: "claude-code" as const,
    field: "disable-model-invocation",
    file: "SKILL.md",
    required: true,
    read: readClaude,
  },
  {
    harness: "codex" as const,
    field: "policy.allow_implicit_invocation",
    file: "agents/openai.yaml",
    required: false,
    read: readCodex,
  },
];

export const assessInvocationConformance = Effect.fn("Integrity.assessInvocationConformance")(
  function* (
    skills: ReadonlyArray<Pick<ContainedSkill, "name" | "path" | "invocation">>,
    readText: (path: string) => string | undefined,
  ) {
    const issues: Array<InvocationConformanceIssue> = [];
    for (const skill of skills) {
      if (!skill.invocation) continue;
      for (const adapter of ADAPTERS) {
        const path = joinPath(skill.path, adapter.file);
        const text = readText(path);
        if (text === undefined && adapter.required) continue;
        const expected = expectedNativeInvocation(adapter.harness, skill.invocation);
        const actual = yield* adapter.read(text, path);
        if (actual === expected) continue;
        issues.push({
          skill: skill.name,
          harness: adapter.harness,
          path,
          field: adapter.field,
          policy: skill.invocation,
          expected,
          actual,
        });
      }
    }
    return issues;
  },
);

export const describeInvocationConformanceIssue = (issue: InvocationConformanceIssue): string => {
  const requirement =
    issue.expected === undefined
      ? `must not set ${issue.field}`
      : `must set ${issue.field}: ${issue.expected}`;
  const found = issue.actual === undefined ? "the field is absent" : `found ${issue.actual}`;
  return `${issue.skill} declares invocation ${issue.policy}, so its ${issue.harness} metadata ${issue.path} ${requirement} (${found}); run \`skit author invocation\` to write it`;
};
