import { expect, test } from "vitest";
import type { SetupApplyStage } from "@smolai/skit-core/library/setup";
import { setupProgressMessage } from "../src/library/setup/progress.js";

const stages = {
  Import: { _tag: "Import", collections: 2, skills: 3 },
  ManageExisting: { _tag: "ManageExisting", reconnects: 1 },
  ManageNew: { _tag: "ManageNew", skills: 2 },
  Remove: { _tag: "Remove", copies: 1 },
} satisfies { [K in SetupApplyStage["_tag"]]: Extract<SetupApplyStage, { _tag: K }> };

test("setup stages are worded by the CLI with their actual counts and order", () => {
  expect(setupProgressMessage({ _tag: "ApplyPlan", stages: Object.values(stages) })).toBe(
    "Applying setup: importing 2 installed Collections (3 Skills), reconnecting 1 existing Library match, managing 2 existing local Skills, removing 1 installed copy",
  );
});

test("setup distinguishes recording, import-only matches", () => {
  expect(setupProgressMessage({ _tag: "ApplyPlan", stages: [] })).toBe(
    "Recording this machine's setup",
  );
  expect(
    setupProgressMessage({
      _tag: "ApplyPlan",
      stages: [{ _tag: "ManageExisting", reconnects: 0 }],
    }),
  ).toBe("Applying setup: keeping existing Library matches without enabling");
  expect(setupProgressMessage({ _tag: "RevalidatePlan" })).toBe(
    "Revalidating the approved setup plan",
  );
  expect(setupProgressMessage({ _tag: "SaveDiscoveryRoots" })).toBe(
    "Saving this machine's discovery roots",
  );
});
