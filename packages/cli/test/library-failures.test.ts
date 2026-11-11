import { failureExitCode } from "../src/commands/exit-code.js";
import { test, expect } from "vitest";
import { Schema } from "effect";
import {
  AddNoSkills,
  SetupImportInvalid,
  LibrarySubjectNotFound,
  LibrarySubjectAmbiguous,
  SharedMappingInvalid,
  CollectionRemovalMissing,
  SkillRemovalRequiresCollection,
} from "@smolai/skit-core/library";
import { LibraryDataFailure } from "../src/library/failures.js";
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
