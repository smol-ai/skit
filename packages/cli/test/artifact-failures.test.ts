import { failureExitCode } from "../src/commands/exit-code.js";
import { InvocationUnavailable } from "@smolai/skit-core/library/session";
import { TreeError } from "@smolai/skit-core/shared";
import { expect, test } from "vitest";
import { Cause, Schema } from "effect";
import { DescriptorMalformed, ConflictingInvocationDeclaration } from "@smolai/skit-core/author";
import { HarnessMetadataInvalid } from "@smolai/skit-core/harnesses";
import { ArtifactDataFailure } from "../src/platform/artifact-failures.js";
import { classifyFailure, commandFailure } from "../src/commands/failure-classification.js";
import { Block } from "../src/terminal/blocks.js";
import { SkitValidationFailed } from "@smolai/skit-core/author";
import { CommandError } from "../src/commands/error-output.js";

test("archive validation retains diagnostic facts through the CLI error codec", () => {
  const diagnostic = {
    code: "INVOCATION_METADATA_MISMATCH" as const,
    severity: "error" as const,
    path: "skills/review/agents/openai.yaml",
    issue: {
      skill: "review",
      harness: "codex" as const,
      path: "skills/review/agents/openai.yaml",
      field: "allow_implicit_invocation",
      policy: "explicit" as const,
      expected: "explicit" as const,
      actual: "implicit" as const,
    },
  };
  const original = new SkitValidationFailed({ diagnostics: [diagnostic] });
  const encoded = Schema.encodeSync(CommandError)({
    code: original.code,
    cause: Cause.fail(original),
  });
  expect(encoded.cause).toEqual([
    { _tag: "Fail", error: { _tag: "SkitValidationFailed", diagnostics: [diagnostic] } },
  ]);
  const stored = Schema.decodeUnknownSync(CommandError)(JSON.parse(JSON.stringify(encoded)));
  for (const shown of [classifyFailure(original), commandFailure(stored.cause)]) {
    expect(shown.message).toContain("review declares invocation explicit");
    expect(shown.message).toContain("allow_implicit_invocation: false (found true)");
    expect(shown.message).toContain(diagnostic.path);
    expect(shown.message).not.toContain("INVOCATION_METADATA_MISMATCH");
  }
});

test.each([
  [
    {
      _tag: "NormalizedPathCollision",
      path: "caf\u00e9.txt",
      firstPath: "caf\u00e9.txt",
      secondPath: "cafe\u0301.txt",
    },
    'Paths "caf\\u00e9.txt" and "cafe\\u0301.txt"',
  ],
  [
    { _tag: "NativeIdentityMissing", path: ".", entryType: "Directory" },
    "Cannot record the filesystem identity",
  ],
  [
    { _tag: "RootNotDirectory", path: ".", entryType: "SymbolicLink" },
    "Tree root must be a directory; found a symbolic link",
  ],
] as const)(
  "tree facts retain their precise explanation across JSON: %j",
  (reason, explanation) => {
    const failure = new TreeError({ reason });
    const wire = Schema.encodeSync(TreeError)(failure);
    expect(wire).not.toHaveProperty("message");
    const stored = Schema.decodeUnknownSync(TreeError)(JSON.parse(JSON.stringify(wire)));
    expect(classifyFailure(failure).message).toContain(explanation);
    expect(classifyFailure(stored).message).toBe(classifyFailure(failure).message);
  },
);

test("descriptor diagnostics and metadata paths survive the data codec and get frontend guidance", () => {
  for (const [error, exitCode, message] of [
    [
      new DescriptorMalformed({
        format: "yaml",
        issue: {
          _tag: "YamlSyntax",
          errors: [{ code: "UNEXPECTED_TOKEN", start: 2, end: 3, line: 2, column: 3 }],
        },
      }),
      1,
      "Malformed YAML SKIT Descriptor: unexpected token at line 2, column 3",
    ],
    [
      new ConflictingInvocationDeclaration({ skill: "review" }),
      1,
      "review declares conflicting invocation and trigger_modes values",
    ],
    [
      new HarnessMetadataInvalid({ path: "/skills/review/SKILL.md", kind: "SKILL.md frontmatter" }),
      1,
      "Invalid SKILL.md frontmatter: /skills/review/SKILL.md",
    ],
  ] as const) {
    const encoded = Schema.encodeSync(ArtifactDataFailure)(error);
    expect(encoded).not.toHaveProperty("message");
    expect(encoded).not.toHaveProperty("remediation");
    const decoded = Schema.decodeUnknownSync(ArtifactDataFailure)(
      JSON.parse(JSON.stringify(encoded)),
    );
    expect(classifyFailure(decoded)).toMatchObject({ code: error.code, message });
    expect(failureExitCode(error.code)).toBe(exitCode);
    expect(classifyFailure(decoded).remediation).not.toBe("Check the reported failure and retry.");
  }
});

test("an unavailable preference preserves its validation exit code while formatting the reader facts", () => {
  const error = new InvocationUnavailable({
    failure: new TreeError({ reason: { _tag: "ChangedDuringRead", path: "/source/review" } }),
  });
  const decoded = Schema.decodeUnknownSync(InvocationUnavailable)(
    JSON.parse(JSON.stringify(Schema.encodeSync(InvocationUnavailable)(error))),
  );
  const formatted = classifyFailure(decoded);
  expect(formatted.code).toBe("VALIDATION_FAILED");
  expect(formatted.presentation).toEqual([
    Block.Status({ tone: "error", text: ["SKIT validation failed"] }),
    Block.Group({
      title: "Validation failed",
      children: classifyFailure(decoded.failure).explanation,
    }),
    Block.Fields({
      rows: [
        {
          label: "Next",
          value: classifyFailure(decoded.failure).next,
        },
      ],
    }),
  ]);
});

test("schema diagnostic facts get path and constraint wording after the failure codec", () => {
  const error = new DescriptorMalformed({
    format: "json",
    issue: {
      _tag: "Schema",
      failure: {
        _tag: "StoredSchemaFailure",
        issues: [
          {
            path: ["skills", 0, "path"],
            reason: {
              _tag: "InvalidValue",
              check: { id: "skit/schema/path-relative", payload: null },
            },
          },
          { path: ["slug"], reason: { _tag: "InvalidType", expected: [{ type: "String" }] } },
        ],
      },
    },
  });
  const encoded = Schema.encodeSync(ArtifactDataFailure)(error);
  expect(JSON.stringify(encoded)).not.toContain("must");
  const decoded = Schema.decodeUnknownSync(ArtifactDataFailure)(
    JSON.parse(JSON.stringify(encoded)),
  );
  const message = classifyFailure(decoded).message;
  expect(message).toContain('Path must be safe and relative at ["skills"][0]["path"]');
  expect(message).toContain('Expected string at ["slug"]');
  expect(failureExitCode(classifyFailure(decoded).code)).toBe(1);
});
