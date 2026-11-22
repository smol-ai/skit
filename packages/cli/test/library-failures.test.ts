import { failureExitCode } from "../src/commands/exit-code.js";
import { test, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  AddNoSkills,
  InvalidLibraryState,
  SetupImportInvalid,
  LibrarySubjectNotFound,
  LibrarySubjectAmbiguous,
  SharedMappingInvalid,
  CollectionRemovalMissing,
  SkillRemovalRequiresCollection,
} from "@smolai/skit-core/library";
import { LibraryDataFailure, libraryFailure } from "../src/library/failures.js";
import { classifyFailure } from "../src/commands/failure-classification.js";

test("source and removal failures retain facts and codes after decoding, with words supplied by the CLI", () => {
  const cases = [
    {
      error: new AddNoSkills({ source: "/sources/empty" }),
      exitCode: 1,
      message: "No Skills found in /sources/empty",
    },
    {
      error: new SetupImportInvalid({ skillName: "review", reason: "lock-changed" }),
      exitCode: 1,
      message:
        "Cannot import review during setup: the lock file no longer matches the scanned copy",
    },
    {
      error: new LibrarySubjectNotFound({ query: "review" }),
      exitCode: 1,
      message: "No Skill or Collection in the Library matches review",
    },
    {
      error: new LibrarySubjectAmbiguous({ query: "review" }),
      exitCode: 1,
      message: "More than one Skill or Collection in the Library matches review",
    },
    {
      error: new SharedMappingInvalid({ target: "../escape" }),
      exitCode: 1,
      message: "Shared mapping target escaped Skill: ../escape",
    },
    {
      error: new CollectionRemovalMissing({ collection_id: "collection" }),
      exitCode: 1,
      message: "Collection is no longer in the Library: collection",
    },
    {
      error: new SkillRemovalRequiresCollection({ skill_id: "skill", collection_id: "collection" }),
      exitCode: 1,
      message: "skill can be removed only with its Collection collection",
    },
  ];
  for (const { error, exitCode, message } of cases) {
    const encoded = Schema.encodeSync(LibraryDataFailure)(error);
    expect(encoded).not.toHaveProperty("message");
    expect(encoded).not.toHaveProperty("remediation");
    const decoded = Schema.decodeUnknownSync(LibraryDataFailure)(
      JSON.parse(JSON.stringify(encoded)),
    );
    expect(classifyFailure(decoded)).toMatchObject({ code: error.code, message });
    expect(failureExitCode(error.code)).toBe(exitCode);
  }
  expect(classifyFailure(cases[2]!.error).remediation).toContain("skit list");
  expect(classifyFailure(cases[6]!.error).remediation).toContain("skit remove collection");
});

test.each([
  ["duplicate-selection", "selected more than once"],
  ["candidate-not-found", "absent from the current import choices"],
  ["observation-missing", "no complete Skill and lock-file evidence"],
  ["contested-observation", "lock-file entries name different sources"],
  ["source-unresolvable", "do not identify one importable source"],
  ["lock-changed", "no longer matches the scanned copy"],
] as const)("setup import explains %s after a JSON roundtrip", (reason, words) => {
  const failure = new SetupImportInvalid({ skillName: "review", reason });
  const stored = Schema.decodeUnknownSync(SetupImportInvalid)(
    JSON.parse(JSON.stringify(Schema.encodeSync(SetupImportInvalid)(failure))),
  );
  const shown = classifyFailure(stored);
  expect(shown.message).toContain(words);
  expect(shown.message).not.toContain(reason);
  expect(shown.remediation).toContain("skit setup");
});

it.effect("SQLite schema failures use the same recovery action as an empty database", () =>
  Effect.gen(function* () {
    const path = "/library/library.sqlite";
    const reason = yield* Effect.flip(Schema.decodeUnknownEffect(Schema.String)(42));
    const failure = new InvalidLibraryState({
      path,
      reason: { _tag: "SchemaInvalid", failure: reason },
    });
    const empty = new InvalidLibraryState({ path, reason: { _tag: "DatabaseEmpty" } });
    expect(libraryFailure(failure).next).toEqual(libraryFailure(empty).next);
  }),
);

test("database damage, refused edits and transaction mistakes have distinct actions", () => {
  const path = "/library/library.sqlite";
  const action = (reason: InvalidLibraryState["reason"]) => {
    const error = new InvalidLibraryState({ path, reason });
    return libraryFailure(error).next;
  };
  const backup = action({ _tag: "DatabaseEmpty" });
  const report = action({ _tag: "DatabaseWriteInsideRead" });
  const review = action({ _tag: "UndoFieldChanged", field: "unmanaged" });
  expect(action({ _tag: "DatabaseWriterLockMissing" })).toEqual(report);
  expect(action({ _tag: "EnabledSubjectMissing", subject: "skill", id: "skill" })).toEqual(review);
  expect(new Set([backup, report, review].map((value) => JSON.stringify(value))).size).toBe(3);
});
