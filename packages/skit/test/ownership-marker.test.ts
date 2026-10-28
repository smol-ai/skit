import { assert, it } from "@effect/vitest";
import {
  makeCollectionId,
  makeInstalledSkillId,
  makeSkillId,
  makeSkillVersionId,
} from "../src/library/entity-ids.js";
import { parseOwnershipMarker } from "../src/projection/mutation.js";

const current = {
  schemaVersion: 5,
  installed_skill_id: makeInstalledSkillId(),
  skill_id: makeSkillId(),
  skill_version_id: makeSkillVersionId(),
  expected_digest: `sha256:${"a".repeat(64)}`,
} as const;
const { schemaVersion: _version, installed_skill_id, ...fields } = current;
const v4 = {
  ...fields,
  schemaVersion: 4,
  projectionPolicyVersion: 1,
  projection_id: installed_skill_id,
};

it("reads v2, v3 and v4 ownership markers as the current marker", () => {
  assert.deepStrictEqual(parseOwnershipMarker(current), { kind: "valid", marker: current });
  assert.deepStrictEqual(parseOwnershipMarker(v4), { kind: "valid", marker: current });
  assert.deepStrictEqual(parseOwnershipMarker({ ...v4, schemaVersion: 3, harness: "codex" }), {
    kind: "valid",
    marker: current,
  });
  assert.deepStrictEqual(
    parseOwnershipMarker({
      ...v4,
      schemaVersion: 2,
      collection_id: makeCollectionId(),
      harness: "claude-code",
    }),
    { kind: "valid", marker: current },
  );
});

it("rejects a marker from no released version", () => {
  assert.strictEqual(parseOwnershipMarker({ ...v4, schemaVersion: 1 }).kind, "invalid");
});
