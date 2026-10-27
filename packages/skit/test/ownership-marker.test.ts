import { assert, it } from "@effect/vitest";
import {
  makeCollectionId,
  makeInstalledSkillId,
  makeSkillId,
  makeSkillVersionId,
} from "../src/library/entity-ids.js";
import { parseOwnershipMarker } from "../src/projection/mutation.js";

const current = {
  schemaVersion: 4,
  projectionPolicyVersion: 1,
  projection_id: makeInstalledSkillId(),
  skill_id: makeSkillId(),
  skill_version_id: makeSkillVersionId(),
  expected_digest: `sha256:${"a".repeat(64)}`,
} as const;

it("reads v2 and v3 ownership markers as the current marker", () => {
  assert.deepStrictEqual(parseOwnershipMarker({ ...current, schemaVersion: 3, harness: "codex" }), {
    kind: "valid",
    marker: current,
  });
  assert.deepStrictEqual(
    parseOwnershipMarker({
      ...current,
      schemaVersion: 2,
      collection_id: makeCollectionId(),
      harness: "claude-code",
    }),
    { kind: "valid", marker: current },
  );
});

it("rejects a marker from no released version", () => {
  assert.strictEqual(parseOwnershipMarker({ ...current, schemaVersion: 1 }).kind, "invalid");
});
