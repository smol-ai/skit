import { expect, test } from "vitest";
import { Schema } from "effect";
import {
  SkitValidationDiagnostic,
  PublicationDiagnostic,
} from "@smolai/skit-core/universal/consumer";
import {
  validationDiagnostic,
  publicationDiagnostic,
} from "../src/platform/validation-diagnostic.js";

test("invocation facts survive JSON and acquire native polarity and recovery wording in the CLI", () => {
  for (const [harness, field, expectedValue] of [
    ["claude-code", "disable-model-invocation", "true"],
    ["codex", "policy.allow_implicit_invocation", "false"],
  ] as const) {
    const diagnostic = Schema.decodeUnknownSync(SkitValidationDiagnostic)({
      code: "INVOCATION_METADATA_MISMATCH",
      severity: "error",
      path: "skills/review/SKILL.md",
      issue: {
        skill: "review",
        harness,
        field,
        path: "skills/review/SKILL.md",
        policy: "explicit",
        expected: "explicit",
        actual: undefined,
      },
    });
    const wire = Schema.encodeSync(SkitValidationDiagnostic)(diagnostic);
    const decoded = Schema.decodeUnknownSync(SkitValidationDiagnostic)(
      JSON.parse(JSON.stringify(wire)),
    );
    expect(decoded).toEqual(diagnostic);
    const message = validationDiagnostic(decoded);
    expect(message).toContain(`must set ${field}: ${expectedValue}`);
    expect(message).toContain("the field is absent");
    expect(message).toContain("skit author invocation");
  }
});

test("publication keeps external Registry evidence distinct from local diagnostic wording", () => {
  expect(
    publicationDiagnostic({
      _tag: "RegistryDiagnostic",
      code: "CUSTOM_REMOTE_RULE",
      severity: "error",
      message: "Registry supplied explanation",
    }),
  ).toBe("Registry supplied explanation");
  expect(
    publicationDiagnostic({
      code: "EXAMPLE_ID_DUPLICATE",
      severity: "error",
      path: "examples/review/example/case.yaml",
      skill: "review",
      id: "example",
    }),
  ).toBe("Duplicate example identity review:example");
});

test("a Registry code that matches a local code retains the Registry evidence through its codec", () => {
  const wire = {
    _tag: "RegistryDiagnostic",
    code: "SKILL_FILE_MISSING",
    severity: "error",
    path: "remote/SKILL.md",
    message: "Registry specific evidence",
  } as const;
  const decoded = Schema.decodeUnknownSync(PublicationDiagnostic)(wire);
  expect(Schema.encodeSync(PublicationDiagnostic)(decoded)).toEqual(wire);
  expect(publicationDiagnostic(decoded)).toBe("Registry specific evidence");
});
