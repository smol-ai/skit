import { expect, test } from "vitest";
import { Result, Schema } from "effect";
import { apiBase64Schema } from "../src/api/contracts.js";
import { AbsoluteDevicePath } from "../src/library/device-state.js";
import {
  CollectionId,
  makeInstalledSkillId,
  makeSkillId,
  makeSkillVersionId,
} from "../src/library/entity-ids.js";
import { Hash } from "../src/shared/hash.js";
import { RecordedInstalledChange } from "../src/library/store/state-schema.js";
import { LegacyFileIdentityNumber } from "../src/platform/link-stat.js";
import { SchemaFailure } from "../src/shared/schema-issue.js";
import { stepError } from "../src/library/store/step-error.js";
import { StepError } from "../src/library/store/state-schema.js";
import { StepSchemaFailure } from "../src/library/recorded-failures.js";
import { AuthorWatchRetrying } from "../src/author/watch.js";

test("raw native schema issues retain identity until a recorded step crosses JSON", () => {
  const result = Schema.decodeUnknownResult(Schema.Struct({ enabled: Schema.Boolean }))({
    enabled: "bad",
  });
  if (!Result.isFailure(result)) throw new Error("Invalid input accepted");
  const issue = result.failure.issue;
  const recorded = stepError(issue);
  expect(recorded).toBeInstanceOf(StepSchemaFailure);
  if (!(recorded instanceof StepSchemaFailure))
    throw new Error("Schema issue recorded as a defect");
  expect(recorded.failure).toBe(issue);
  expect(Schema.encodeSync(SchemaFailure)(issue)).toEqual(
    Schema.encodeSync(SchemaFailure)(result.failure),
  );
  const stored = Schema.decodeUnknownSync(StepError)(
    JSON.parse(JSON.stringify(Schema.encodeSync(StepError)(recorded))),
  );
  expect(stored).toBeInstanceOf(StepSchemaFailure);
  expect(Schema.encodeSync(StepError)(stored)).toEqual(Schema.encodeSync(StepError)(recorded));
  for (const failure of [issue, result.failure]) {
    const event = { event: "retrying" as const, operation: "observe" as const, failure };
    expect(AuthorWatchRetrying.make(event).failure).toBe(failure);
    expect(Schema.encodeSync(Schema.toCodecJson(AuthorWatchRetrying))(event)).toEqual({
      event: "retrying",
      operation: "observe",
      failure: Schema.encodeSync(SchemaFailure)(failure),
    });
  }
});

test("base64 keeps its linear alphabet and padding validation", () => {
  for (const value of ["", "AAAA", "AA==", "AAA=", "a".repeat(4 * 1024 * 1024)])
    expect(Schema.is(apiBase64Schema)(value)).toBe(true);
  for (const value of ["A", "AA", "AAA", "A===", "=AAA", "A=AA", "AA=A", "AA-_", "AAAA\n"])
    expect(Schema.is(apiBase64Schema)(value)).toBe(false);
  const failure = Schema.decodeResult(apiBase64Schema)("invalid");
  if (!Result.isFailure(failure)) throw new Error("Invalid base64 accepted");
  expect(Schema.encodeSync(SchemaFailure)(failure.failure)).toEqual({
    issues: [
      {
        path: [],
        reason: {
          _tag: "InvalidValue",
          check: { id: "skit/schema/base64", payload: null },
        },
      },
    ],
  });
});

test("nested path and TypeID failures preserve their locations and constraint facts", () => {
  const result = Schema.decodeResult(
    Schema.Struct({ root: AbsoluteDevicePath, id: CollectionId }),
    { errors: "all" },
  )({
    root: "relative",
    id: "skill_01m2xxw78tfeva4p48mn5xbprh",
  });
  if (!Result.isFailure(result)) throw new Error("Invalid fields accepted");
  expect(Schema.encodeSync(SchemaFailure)(result.failure)).toEqual({
    issues: [
      {
        path: ["root"],
        reason: { _tag: "InvalidValue", check: { id: "skit/schema/path-absolute", payload: null } },
      },
      {
        path: ["id"],
        reason: {
          _tag: "InvalidValue",
          check: { id: "skit/schema/typeid", payload: { prefix: "coll" } },
        },
      },
    ],
  });
});

test("legacy numeric filesystem identities decode exactly and cannot encode lossy numbers", () => {
  expect(Schema.decodeSync(LegacyFileIdentityNumber)(123)).toBe(123n);
  const result = Schema.encodeResult(LegacyFileIdentityNumber)(9007199254740993n);
  if (!Result.isFailure(result)) throw new Error("Lossy legacy identity encoding accepted");
  expect(Schema.encodeSync(SchemaFailure)(result.failure)).toEqual({
    issues: [{ path: [], reason: { _tag: "Forbidden" } }],
  });
});

test("recorded installed changes still reject a result that disagrees with the row", () => {
  const row = {
    installed_skill_id: makeInstalledSkillId(),
    skill_id: makeSkillId(),
    skill_version_id: makeSkillVersionId(),
    destination: "agents" as const,
    root: "/work",
    path: "/work/.agents/skills/review",
    expected_hash: Hash.make(`sha256:${"a".repeat(64)}`),
    installed_at: "2026-11-11T00:00:00.000Z",
    status: "installed" as const,
  };
  expect(
    Schema.is(RecordedInstalledChange)({ _tag: "Save", row, result: "Unchanged", backUp: false }),
  ).toBe(true);
  const result = Schema.decodeResult(RecordedInstalledChange)({
    _tag: "Save",
    row,
    result: "Suppressed",
    backUp: false,
  });
  if (!Result.isFailure(result)) throw new Error("Inconsistent installed result accepted");
  expect(Schema.encodeSync(SchemaFailure)(result.failure)).toEqual({
    issues: [
      {
        path: [],
        reason: {
          _tag: "InvalidValue",
          check: { id: "skit/schema/installed-change-status", payload: null },
        },
      },
    ],
  });
});
