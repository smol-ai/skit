import { assert, it } from "@effect/vitest";
import { makeMachineId } from "@smolai/skit-core";
import { sourceFromUpstream } from "../src/workflows/library/upstream-source.js";

it("reconstructs Git refresh input from upstream tracking and selection", () => {
  assert.deepStrictEqual(
    sourceFromUpstream({
      source_identity: {
        kind: "github",
        owner: "smol-ai",
        repository: "skills",
        collection_root: "packages",
      },
      tracking: { kind: "branch", ref: "main" },
      selection: {
        kind: "selected-paths",
        paths: ["review/SKILL.md", "test/SKILL.md"],
      },
    }),
    {
      type: "git",
      locator:
        "https://github.com/smol-ai/skills.git#ref=main&path=packages&skill=review%2FSKILL.md&skill=test%2FSKILL.md",
    },
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
      selection: { kind: "full-tree" },
    }),
    undefined,
  );
});
