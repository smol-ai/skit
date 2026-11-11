import { Effect, FileSystem } from "effect";
import { it } from "@effect/vitest";
import { skitLayer } from "@smolai/skit-core/platform";
import { resolve } from "node:path";
import { expect } from "vitest";
import { storyCoverage, resultVariants } from "../src/storybook/coverage.js";
import { result } from "../src/commands/result.js";
import { authorSyncDetails, authorSyncGaps } from "../src/storybook/author-sync-inventory.js";
import { authorSyncScenarioInventory } from "../src/storybook/author-sync-journey.js";
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

it.effect("inventories nested reason tags from their owning schemas and leaves gaps explicit", () =>
  Effect.gen(function* () {
    for (const [name, count] of [
      ["AuthorSyncStateInvalid", 4],
      ["AuthorWorkspaceUnsafe", 6],
      ["AuthorHistoryInvalid", 12],
      ["AuthorWorkspaceInvariantFailed (internal defect)", 5],
    ] as const) {
      const detail = authorSyncDetails.find(
        (detail) => detail.title === `${name}: reason branches`,
      );
      expect(
        detail?.body
          .split(". A class-level")[0]
          ?.replace("Source-defined reasons: ", "")
          .split(", "),
      ).toHaveLength(count);
    }
    const fs = yield* FileSystem.FileSystem;
    for (const detail of authorSyncDetails)
      expect(yield* fs.exists(resolve("../..", detail.source)), detail.source).toBe(true);
    const names = [...authorSyncScenarioInventory, ...authorSyncGaps].map(
      (scenario) => scenario.name,
    );
    expect(new Set(names).size).toBe(names.length);
  }).pipe(Effect.provide(skitLayer)),
);
