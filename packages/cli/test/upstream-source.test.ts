import { assert, it } from "@effect/vitest";
import { makeMachineId } from "@smolai/skit-core";
import { sourceFromUpstream } from "../src/workflows/library/upstream-source.js";

it("refreshes the whole Git Source from its tracking and collection root", () => {
  assert.deepStrictEqual(
    sourceFromUpstream({
      source_identity: {
        kind: "github",
        owner: "smol-ai",
        repository: "skills",
        collection_root: "packages",
      },
      tracking: { kind: "branch", ref: "main" },
    }),
    {
      type: "github",
      owner: "smol-ai",
      repository: "skills",
      ref: "main",
      subpath: "packages",
    },
  );
});

it("refreshes a whole-repository Source without selecting Skills", () => {
  assert.deepStrictEqual(
    sourceFromUpstream({
      source_identity: {
        kind: "github",
        owner: "mattpocock",
        repository: "skills",
        collection_root: ".",
      },
      tracking: { kind: "default" },
    }),
    { type: "github", owner: "mattpocock", repository: "skills" },
  );
});

it("does not turn local provenance into refresh intent", () => {
  assert.strictEqual(
    sourceFromUpstream({
      source_identity: {
        kind: "local",
        machine_id: makeMachineId(),
        path: { value: "/tmp/skills" },
      },
      tracking: { kind: "default" },
    }),
    undefined,
  );
});
