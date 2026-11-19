import { authorSyncScenarioSet } from "../src/storybook/author-sync-journey.js";
import { authorWatchScenarioSet } from "../src/storybook/author-watch-journey.js";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { skitLayer } from "@smolai/skit-core/platform";
import { makeJourneyHome } from "../src/platform/storybook-fixtures.js";
import { scenarioSets } from "../src/storybook/scenario-sets.js";
import { makeScriptedInteraction } from "../src/storybook/interaction-recorder.js";

const register = (scenario: (typeof scenarioSets)[number]["scenarios"][number]) => {
  it.live(
    scenario.name,
    () =>
      Effect.gen(function* () {
        const interaction = yield* makeScriptedInteraction(scenario.answers);
        yield* scenario
          .run(yield* makeJourneyHome, interaction.typed)
          .pipe(Effect.provide(interaction.layer));
        expect(yield* interaction.remaining, scenario.name).toBe(0);
        const events = yield* interaction.events;
        expect(events[0]?._tag, scenario.name).toBe("Command");
      }).pipe(Effect.provide(skitLayer)),
    { timeout: 30_000 },
  );
};

for (const set of scenarioSets.filter(
  (set) => set.command !== "author watch" && set.command !== "author sync",
))
  for (const scenario of set.scenarios) register(scenario);

const watch = authorWatchScenarioSet.scenarios;
expect(watch).toHaveLength(4);
const select = (names: readonly string[]) => {
  const scenarios = watch.filter((scenario) => names.includes(scenario.name));
  expect(scenarios.map((scenario) => scenario.name).sort()).toEqual([...names].sort());
  return scenarios;
};
describe("skit author watch", () => {
  describe("Watch saves edits while the Registry is offline and syncs them after recovery.", () => {
    for (const scenario of select([
      "author-watch/offline-install-and-recover",
      "author-watch/unregistered-recovery",
    ]))
      register(scenario);
  });
  describe("Watch saves and syncs an atomic save and updates enabled copies on both devices.", () => {
    for (const scenario of select(["author-watch/atomic-save"])) register(scenario);
  });
  describe("Watch saves local edits while a Registry request is stalled.", () => {
    for (const scenario of select(["author-watch/stalled-registry"])) register(scenario);
  });
});

const sync = authorSyncScenarioSet.scenarios;
expect(sync).toHaveLength(25);
const selectSync = (names: readonly string[]) => {
  const scenarios = sync.filter((scenario) => names.includes(scenario.name));
  expect(scenarios.map((scenario) => scenario.name).sort()).toEqual([...names].sort());
  return scenarios;
};

describe("skit author sync", () => {
  describe("Connecting and previewing", () => {
    describe("First sync creates an unpublished Registry revision.", () => {
      for (const scenario of selectSync(["author-sync/first-connection"])) register(scenario);
    });
    describe("An interrupted first sync resumes its original creation request.", () => {
      for (const scenario of selectSync([
        "author-sync/creation-lost-response-before-create",
        "author-sync/creation-lost-response-after-create",
        "author-sync/creation-lost-response-after-post",
        "author-sync/creation-lost-response-after-move",
      ]))
        register(scenario);
    });
    describe("Sync refuses to claim an existing SKIT without this workspace’s connection history.", () => {
      for (const scenario of selectSync(["author-sync/destination-exists"])) register(scenario);
    });
    describe("Preview leaves the proposed sync unapplied.", () => {
      for (const scenario of selectSync([
        "author-sync/preview-push",
        "author-sync/preview-pull",
        "author-sync/preview-merge",
      ]))
        register(scenario);
    });
    describe("Sync refuses saved state it cannot understand.", () => {
      for (const scenario of selectSync(["author-sync/invalid-checkpoint"])) register(scenario);
    });
  });
  describe("Choosing what changes", () => {
    describe("Removing most or all synced files requires explicit approval.", () => {
      for (const scenario of selectSync(["author-sync/bulk-removal-approval"])) register(scenario);
    });
    describe("Sync gives missing files a confirmation period before sending their removal.", () => {
      for (const scenario of selectSync(["author-sync/removal-waits-and-reappears"]))
        register(scenario);
    });
  });
  describe("Combining edits", () => {
    describe("For overlapping edits, the version observed later wins.", () => {
      for (const scenario of selectSync([
        "author-sync/overlap-local",
        "author-sync/overlap-remote",
      ]))
        register(scenario);
    });
    describe("For overlapping edits observed at the same time, the syncing device keeps its version.", () => {
      for (const scenario of selectSync(["author-sync/overlap-equal"])) register(scenario);
    });
    describe("An edit wins over a conflicting deletion.", () => {
      for (const scenario of selectSync(["author-sync/delete-versus-edit"])) register(scenario);
    });
    describe("A device with no shared sync history can join an existing SKIT.", () => {
      for (const scenario of selectSync([
        "author-sync/no-base-empty",
        "author-sync/no-base-nonempty",
      ]))
        register(scenario);
    });
  });
  describe("Recovering interrupted work", () => {
    describe("Retrying an interrupted upload does not replace a newer Registry revision with an older one.", () => {
      for (const scenario of selectSync([
        "author-sync/remote-cas-race",
        "author-sync/sending-recovery-before-move",
        "author-sync/sending-recovery-after-move",
      ]))
        register(scenario);
    });
    describe("Sync can resume a partly written incoming change.", () => {
      for (const scenario of selectSync([
        "author-sync/writing-recovery-pull",
        "author-sync/writing-recovery-merge",
      ]))
        register(scenario);
    });
    describe("Sync can recover an interrupted replacement between a file and a folder.", () => {
      for (const scenario of selectSync([
        "author-sync/file-to-directory",
        "author-sync/directory-to-file",
      ]))
        register(scenario);
    });
  });
});
