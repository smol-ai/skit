import { assert, it } from "@effect/vitest";
import {
  makeCollectionId,
  makeInstalledSkillId,
  makeSkillId,
  makeSkillVersionId,
} from "../src/library/entity-ids.js";
import {
  parseOwnershipMarker,
  inspectOwnershipMarker,
} from "../src/installed-skills/marker-inspection.js";
import { OwnershipMarkerInvalidReason } from "../src/installed-skills/marker-failures.js";
import { Effect, FileSystem, Schema } from "effect";
import { systemError } from "effect/PlatformError";
import { skitLayer } from "../src/platform/layer.js";
import { join } from "node:path";

const current = {
  schemaVersion: 5,
  installed_skill_id: makeInstalledSkillId(),
  skill_id: makeSkillId(),
  skill_version_id: makeSkillVersionId(),
  expected_hash: `sha256:${"a".repeat(64)}`,
} as const;
const { schemaVersion: _version, installed_skill_id, expected_hash, ...fields } = current;
const v4 = {
  ...fields,
  schemaVersion: 4,
  projectionPolicyVersion: 1,
  projection_id: installed_skill_id,
  expected_digest: expected_hash,
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

it.each([null, [], "marker", 4, false])(
  "records a non-object marker as typed evidence: %j",
  (value) => {
    assert.deepStrictEqual(parseOwnershipMarker(value), {
      kind: "invalid",
      reason: { _tag: "NotObject" },
    });
  },
);

it.effect.each([
  ["{", "InvalidJson"],
  ["null", "NotObject"],
  ["[]", "NotObject"],
  ["{}", "InvalidFields"],
  [JSON.stringify({ ...current, expected_hash: "bad-hash" }), "InvalidFields"],
] as const)("inspects %s as %s without changing the marker", ([text, tag]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const folder = yield* fs.makeTempDirectoryScoped({ prefix: "skit-invalid-marker-" });
    const path = join(folder, ".skit-ownership.json");
    yield* fs.writeFileString(path, text);
    const inspected = yield* inspectOwnershipMarker(folder);
    assert.deepStrictEqual(inspected, { kind: "invalid", reason: { _tag: tag } });
    assert.strictEqual(yield* fs.readFileString(path), text);
    if (inspected.kind !== "invalid") return;
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(OwnershipMarkerInvalidReason)(
        JSON.parse(JSON.stringify(inspected.reason)),
      ),
      inspected.reason,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("an unreadable marker keeps the original filesystem failure", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const original = systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "readFileString",
      pathOrDescriptor: "/skills/review/.skit-ownership.json",
    });
    const failure = yield* inspectOwnershipMarker("/skills/review").pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readFileString: () => Effect.fail(original),
      }),
      Effect.flip,
    );
    assert.strictEqual(failure, original);
  }).pipe(Effect.provide(skitLayer)),
);
