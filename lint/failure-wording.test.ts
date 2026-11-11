import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { coreWordingIssues } from "./core-wording.mjs";

const coreRoot = resolve(import.meta.dirname, "../packages/skit/src");
const repoRoot = resolve(import.meta.dirname, "..");
const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(directory, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(directory, entry.name)]
        : [],
  );

describe("core failure wording boundary", () => {
  test.each([
    ['const next = "skit setup --apply";', "cli-command"],
    ["const next = `Run skit enable ${skill}`;", "cli-command"],
    ['throw new TypeError("Expected a stream");', "untyped-error"],
    ['throw new globalThis["TypeError"]("Expected a stream");', "untyped-error"],
    ["class Failure extends Error {}", "untyped-error"],
    [
      'new HttpClientError.TransportError({ description: "Source must not use the network" });',
      "authored-prose",
    ],
    ["const violation = { issue: `Skill ${name} has no Version` };", "authored-prose"],
    [
      'const failure = { reason: { _tag: "CannotRetain", entryType: "entry without native identity", path } };',
      "authored-prose",
    ],
    ["Effect.die(`Missing metadata for ${skill}`);", "untyped-failure"],
    ['Effect.logWarning("Library history delivery is pending", error);', "authored-log"],
    ['Effect.logWarning(error, "Library history delivery is pending");', "authored-log"],
    ['Effect.logWarning(error, ["Library history delivery is pending", native]);', "authored-log"],
    ["const issue = { reason: `Skill ${name} has no source` };", "authored-prose"],
    ['Schema.makeFilter(check, { message: "Expected an absolute path" });', "authored-prose"],
    ['Schema.makeFilter(check, { expected: "a base64 encoded string" });', "authored-prose"],
    ['Schema.makeFilter(value => value > 0 || "Expected a positive value");', "authored-prose"],
    [
      'Schema.makeFilter(function(value) { if (!value) return "Expected a value"; return true; });',
      "authored-prose",
    ],
    [
      "Schema.makeFilter(check, { message: `Expected a canonical ${prefix} TypeID` });",
      "authored-prose",
    ],
    ['const issue = { message: "Invalid" };', "authored-prose"],
    ['SchemaGetter.forbidden(() => "Old records are decode-only");', "authored-prose"],
    [
      'class Failure extends Schema.TaggedError<Failure>()("Failure", { detail: Schema.optionalKey(Schema.String) }) {}',
      "failure-field",
    ],
    [
      'class Failure extends S.TaggedError<Failure>()("Failure", {}) { get message() { return this.cause.message; } }',
      "failure-member",
    ],
    [
      'import type { SkitFailure as OwnerFailure } from "./failure.js"; class Failure implements OwnerFailure { remediation = next; }',
      "failure-member",
    ],
    [
      "class Failure extends Error { constructor() { super(); this.message = text; } }",
      "failure-member",
    ],
    [
      'class Failure extends Error { constructor() { super(); this["message"] = text; } }',
      "failure-member",
    ],
    [
      'class Failure extends Schema.TaggedError<Failure>()("Failure", { reason: Schema.String.check(Schema.isMinLength(1)) }) {}',
      "failure-field",
    ],
  ])("detects %s", (source, kind) => {
    expect(coreWordingIssues(source).some((issue: { kind: string }) => issue.kind === kind)).toBe(
      true,
    );
  });

  test("allows facts, raw external messages, SQL, comments and user-supplied text", () => {
    expect(
      coreWordingIssues(`
      // A frontend may show skit enable, but core does not produce it.
      const query = sql\`SELECT root FROM collections WHERE id = \${id}\`;
      class Failed extends Schema.TaggedError<Failed>()("Failed", {
        reason: Schema.TaggedUnion({ Missing: { path: Schema.String }, Native: { failure: NativeFailure } }),
      }) {}
      const response = Schema.Struct({ message: Schema.String });
      const observed = { message: response.message, reason: { _tag: "Missing", path: "/tmp/skill folder/SKILL.md" } };
      const tag = FailureReason.Error({ code: "NATIVE" });
    `),
    ).toEqual([]);
  });

  test("current core authors no failure prose or executable CLI text", () => {
    const issues = sourceFiles(coreRoot).flatMap((file) =>
      coreWordingIssues(readFileSync(file, "utf8"), file).map(
        (issue: { line: number; kind: string }) =>
          `${relative(repoRoot, file)}:${issue.line} ${issue.kind}`,
      ),
    );
    expect(issues).toEqual([]);
  });
});
