import { expect, test } from "vitest";
import { Result, Schema } from "effect";
import { LibraryManifest } from "@smolai/skit-core/library";
import { SchemaFailure } from "@smolai/skit-core/shared";
import { makeCollectionId, makeSkillId } from "@smolai/skit-core/universal/consumer";
import { schemaFailure } from "../src/platform/schema-failure.js";
import { SyncConflicted } from "@smolai/skit-core/library/sync";
import { syncConflict } from "../src/library/sync/conflict.js";
import { localStateViolationIssue } from "@smolai/skit-core/library/local-state-violation";
import { outputStories } from "../src/storybook/output-stories.js";

const collectionId = makeCollectionId();
const skillId = makeSkillId();
const empty = {
  schema: "skit.library.v8" as const,
  collections: [],
  skills: [],
  collection_versions: [],
  imports: [],
  snapshot_digests: [],
  enabled: [],
};

test.each([
  {
    data: {
      ...empty,
      collections: [
        { collection_id: collectionId, label: "tools" },
        { collection_id: collectionId, label: "other" },
      ],
    },
    explanation: "Collections contain duplicate IDs",
  },
  {
    data: { ...empty, enabled: [{ skill: skillId }] },
    explanation: "The enabled list names a skill missing from the Library",
  },
])(
  "native and stored manifest facts produce the same explanation: $explanation",
  ({ data, explanation }) => {
    const result = Schema.decodeUnknownResult(LibraryManifest)(data);
    if (!Result.isFailure(result)) throw new Error("Invalid manifest accepted");
    const wire = Schema.encodeSync(Schema.toCodecJson(SchemaFailure))(result.failure);
    const stored = Schema.decodeUnknownSync(SchemaFailure)(JSON.parse(JSON.stringify(wire)));
    expect(schemaFailure(result.failure)).toBe(schemaFailure(stored));
    expect(schemaFailure(stored)).toContain(explanation);
    expect(schemaFailure(stored)).not.toContain("InvalidValue");
    expect(schemaFailure(stored)).not.toContain("library-manifest");
  },
);

test("local missing-reference facts have the same live and stored explanation", () => {
  const schema = Schema.Struct({}).check(
    Schema.makeFilter(() =>
      localStateViolationIssue(["repositories"], {
        _tag: "RepositorySubjectMissing",
        root: "/work/repo",
        kind: "skill",
        id: skillId,
      }),
    ),
  );
  const result = Schema.decodeUnknownResult(schema)({});
  if (!Result.isFailure(result)) throw new Error("Missing local violation");
  const wire = Schema.encodeSync(Schema.toCodecJson(SchemaFailure))(result.failure);
  const stored = Schema.decodeUnknownSync(SchemaFailure)(JSON.parse(JSON.stringify(wire)));
  expect(schemaFailure(result.failure)).toBe(schemaFailure(stored));
  expect(schemaFailure(stored)).toContain(`Repository /work/repo enables missing skill ${skillId}`);
});

test("the Atlas missing-enabled-subject story uses the real validator's precise explanation", () => {
  const story = outputStories.find((story) => story.name === "library-enabled-subject-missing");
  if (story?._tag !== "Failure") throw new Error("Missing manifest failure story");
  expect(story.failure.message).toContain(
    "The enabled list names a skill missing from the Library",
  );
  expect(story.failure.message).not.toContain("EnabledSubjectMissing");
  expect(story.failure.message).not.toContain("library-manifest");
});

test("a sync manifest refusal keeps its precise explanation through JSON and the Atlas result", () => {
  const story = outputStories.find((story) => story.name === "manifest-overlapping-paths");
  if (story?._tag !== "Result" || story.result.contract !== "librarySync")
    throw new Error("Missing sync manifest story");
  const detail = story.result.data.conflict_details?.[0];
  if (detail?._tag !== "LibraryInvalid") throw new Error("Missing manifest conflict");
  expect(Schema.isSchemaError(detail.failure)).toBe(true);
  const wire = Schema.encodeSync(Schema.toCodecJson(SyncConflicted))(
    new SyncConflicted({ conflicts: [detail] }),
  );
  const stored = Schema.decodeUnknownSync(SyncConflicted)(JSON.parse(JSON.stringify(wire)));
  const text = syncConflict(detail, "conflict");
  expect(syncConflict(stored.conflicts[0]!, "conflict")).toBe(text);
  expect(text).toContain("review-tools");
  expect(text).toContain("review/child");
  expect(text).not.toContain("<filter>");
  expect(text).not.toContain("OverlappingSkillPaths");
  expect(story.result.encodedData.conflict_details?.[0]).toMatchObject({
    _tag: "LibraryInvalid",
    failure: {
      issues: [
        { reason: { _tag: "InvalidValue", check: { payload: { _tag: "OverlappingSkillPaths" } } } },
      ],
    },
  });
});
