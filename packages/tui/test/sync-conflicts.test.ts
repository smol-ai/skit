import { expect, test } from "vitest";
import { Result, Schema } from "effect";
import { LibraryManifest } from "@smolai/skit-core/library";
import { makeSkillId } from "@smolai/skit-core/universal/consumer";
import { SyncConflicted } from "@smolai/skit-core/library/sync";
import { libraryFailure } from "../src/library/failures";

test("the TUI explains native and stored sync manifest failures from their validation facts", () => {
  const id = makeSkillId();
  const decoded = Schema.decodeResult(LibraryManifest)({
    schema: "skit.library.v8",
    collections: [],
    skills: [],
    imports: [],
    collection_versions: [],
    snapshot_digests: [],
    enabled: [{ skill: id }],
  });
  if (Result.isSuccess(decoded)) throw new Error("Expected an invalid manifest");
  const failure = new SyncConflicted({
    conflicts: [
      {
        _tag: "LibraryInvalid",
        key: "manifest:invariants",
        resolution: "local",
        failure: decoded.failure,
      },
    ],
  });
  const wire = Schema.encodeSync(Schema.toCodecJson(SyncConflicted))(failure);
  const stored = Schema.decodeUnknownSync(SyncConflicted)(JSON.parse(JSON.stringify(wire)));
  const text = libraryFailure(failure);
  expect(libraryFailure(stored)).toBe(text);
  expect(text).toContain(`The enabled list names missing skill ${id}`);
  expect(text).not.toContain("<filter>");
  expect(text).not.toContain("Library.SyncConflicted");
  expect(text).not.toContain("--take-remote");
});
