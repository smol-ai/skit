import { expect, test } from "vitest";
import { Result, Schema } from "effect";
import { SchemaFailure } from "@smolai/skit-core/shared";
import { manifestViolationIssue } from "@smolai/skit-core/library/manifest-violation";
import { localStateViolationIssue } from "@smolai/skit-core/library/local-state-violation";
import { schemaFailure } from "../src/skits/internal/integrity/schema-failure.js";

test.each([
  {
    issue: manifestViolationIssue(["enabled"], {
      _tag: "EnabledSubjectMissing",
      kind: "skill",
      id: "missing-skill",
    }),
    explanation: "The enabled list names missing skill missing-skill",
  },
  {
    issue: localStateViolationIssue(["repositories"], {
      _tag: "RepositorySubjectMissing",
      root: "/work/repo",
      kind: "collection",
      id: "missing-collection",
    }),
    explanation: "Repository /work/repo enables missing collection missing-collection",
  },
])(
  "formats native and stored domain facts consistently: $explanation",
  ({ issue, explanation }) => {
    const schema = Schema.Struct({}).check(Schema.makeFilter(() => issue));
    const result = Schema.decodeUnknownResult(schema)({});
    if (!Result.isFailure(result)) throw new Error("Missing validation issue");
    const wire = Schema.encodeSync(Schema.toCodecJson(SchemaFailure))(result.failure);
    const stored = Schema.decodeUnknownSync(SchemaFailure)(JSON.parse(JSON.stringify(wire)));
    expect(schemaFailure(result.failure)).toBe(schemaFailure(stored));
    expect(schemaFailure(result.failure.issue)).toBe(schemaFailure(stored));
    expect(schemaFailure(stored)).toContain(explanation);
  },
);
