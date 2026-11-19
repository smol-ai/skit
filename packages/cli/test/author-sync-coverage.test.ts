import { expect, it } from "vitest";
import { storyCoverage, resultVariants } from "../src/storybook/coverage.js";
import { result } from "../src/commands/result.js";
import { OutputStory, outputStories } from "../src/storybook/output-stories.js";

it("keeps ready actions and merge decisions as separate dimensions with honest output gaps", () => {
  const coverage = storyCoverage().find((contract) => contract.contract === "sync");
  expect(
    coverage?.variants
      ?.filter((variant) => variant.state === "ready")
      .map((variant) => [variant.field, variant.value, variant.stories.length])
      .sort(),
  ).toEqual([
    ["action", "merge", 1],
    ["action", "pull", 1],
    ["action", "push", 1],
  ]);
  expect(coverage?.variants).toContainEqual({
    state: "merged",
    field: "choices.kind",
    value: "binary",
    stories: [],
  });
  const branches = resultVariants(
    result("sync", {
      status: "merged",
      changed: true,
      revision_id: "revision",
      paths: ["note"],
      choices: [{ path: "note", kind: "delete_modify", kept: "local" }],
    }),
  );
  expect(branches).toContainEqual({ field: "choices.kind", value: "delete_modify" });
  expect(branches).toContainEqual({ field: "choices.kept", value: "local" });
});

it("never describes a synthetic preview as changed", () => {
  for (const story of outputStories.filter(OutputStory.$is("Result"))) {
    if (story.result.contract !== "sync") continue;
    if (story.result.data.status === "ready" || story.result.data.status === "first_sync_ready")
      expect(story.result.data.changed).toBe(false);
  }
});
