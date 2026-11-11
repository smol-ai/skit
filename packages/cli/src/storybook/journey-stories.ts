import { listInvocationJourney } from "./list-invocation-journey.js";
import { importReview, makeEnablePreviewFixture } from "../platform/storybook-fixtures.js";
import { SkitConfiguration, skitConfigurationLayer, skitLayer } from "@smolai/skit-core/platform";
import * as Library from "@smolai/skit-core/library";

import { scenarioSets } from "./scenario-sets.js";
import type { StartingWorld } from "./contracts.js";
import { authorSyncJourneys } from "./author-sync-journey.js";
import { doctorJourneys } from "./doctor-journey.js";
import { syncJourney } from "./sync-journey.js";
import { setupJourney } from "./setup-journey.js";
import { syncConflictStory } from "./sync-conflict-journey.js";
import { authorPublishJourney } from "./author-publish-journey.js";
import { listDisableJourney } from "./list-disable-journey.js";
import { authJourney } from "./auth-journey.js";
import { collectionLifecycleJourney } from "./collection-lifecycle-journey.js";
import { Layer, Effect } from "effect";

import { inventoryRootOptions } from "@smolai/skit-core/library/routing";
import { presentSetEnabled } from "../library/enable.js";
import type { Prompter } from "../terminal/prompter.js";
import type { Renderer } from "../terminal/renderer.js";
import type { ScriptedAnswer, TypeCommand } from "./interaction-recorder.js";

import type { CheckRule } from "./rules.js";

export interface JourneyStory<A, E, R> {
  readonly _tag: "Journey";
  readonly name: string;
  readonly description: string;
  readonly evidence?: string;
  readonly expectedOutcome?: "success" | "failure";
  readonly initialState: string;
  readonly answers: ReadonlyArray<ScriptedAnswer>;
  /** Runs the journey in a fresh home folder the runner creates; its paths display under `~`. */
  /** Runs in a fresh home; `typed` records each command line before the command it starts. */
  readonly run: (home: string, typed: TypeCommand, check: CheckRule) => Effect.Effect<A, E, R>;
  readonly finalState: (result: A) => string;
}

export interface ScenarioStory<E, R> extends Omit<
  JourneyStory<void, E, R>,
  "_tag" | "initialState" | "finalState"
> {
  readonly _tag: "Scenario";
  readonly world: StartingWorld;
  readonly worldLabels: Readonly<Record<string, string>>;
  readonly terminalDevice: string;
}

const previewEnable = (journeyHome: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { home, codexRoot, installedEmpty } = yield* makeEnablePreviewFixture(journeyHome);
      const configuration = {
        inventory: inventoryRootOptions(yield* SkitConfiguration, { codex: [codexRoot] }),
      };
      return yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        yield* importReview(home);
        const before = yield* library.read;
        yield* presentSetEnabled({
          action: "enable",
          enabled: true,
          cwd: home,
          all: true,
          dryRun: true,
          interactive: true,
        });
        const after = yield* library.read;
        if (
          before._tag !== "Present" ||
          after._tag !== "Present" ||
          before.revision !== after.revision ||
          !(yield* installedEmpty)
        )
          return yield* Effect.die("The enable preview changed the Library or installed files");
        return yield* library.session.open();
      }).pipe(
        Effect.provide(
          Library.layer({ home, roots: configuration.inventory }).pipe(
            Layer.provideMerge(skitConfigurationLayer(home)),
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(skitLayer.pipe(Layer.provideMerge(skitConfigurationLayer()))));

type StoryError = Effect.Error<
  ReturnType<(typeof scenarioSets)[number]["scenarios"][number]["run"]>
>;

export const journeyStories: ReadonlyArray<
  | ScenarioStory<StoryError, Prompter | Renderer>
  | JourneyStory<
      string,
      Effect.Error<
        | ReturnType<(typeof scenarioSets)[number]["scenarios"][number]["run"]>
        | ReturnType<(typeof authorSyncJourneys)[number]["run"]>
        | ReturnType<(typeof doctorJourneys)[number]["run"]>
        | ReturnType<typeof previewEnable>
        | ReturnType<typeof syncJourney>
        | ReturnType<typeof setupJourney.run>
        | ReturnType<typeof authorPublishJourney.run>
        | ReturnType<typeof listDisableJourney.run>
        | ReturnType<typeof authJourney.run>
        | ReturnType<typeof collectionLifecycleJourney.run>
      >,
      Prompter | Renderer
    >
> = [
  ...doctorJourneys,
  ...authorSyncJourneys,
  ...scenarioSets.flatMap((set) => set.scenarios),
  {
    _tag: "Journey",
    name: "preview-enable-portable-collection",
    description: "Preview enabling a collection everywhere on this device without installing it.",
    initialState: "1 Collection | 1 Skill | 0 Bindings",
    answers: [{ label: "review-tools" }, "global"],
    run: (home, typed) =>
      typed("skit enable --all --dry-run").pipe(
        Effect.andThen(previewEnable(home)),
        Effect.map(
          (state) =>
            `${state.skills.length} Skill | ${state.skills.flatMap((skill) => skill.scopes).length} Bindings`,
        ),
      ),
    finalState: (state) => state,
  },
  {
    _tag: "Journey",
    name: "library-sync/fresh-device",
    description: "Download the Library and install its enabled skills on a fresh device.",
    initialState: "Empty fixture device | remote has 3 Collections and 3 enabled Skills",
    answers: [],
    run: (home, typed) => syncJourney(false, home, typed),
    finalState: (state) => state,
  },
  {
    _tag: "Journey",
    name: "library-sync/download-failed",
    description: "Show what happens when the Registry rejects a skill download during sync.",
    expectedOutcome: "failure",
    initialState: "Empty fixture device | Registry rejects the second download",
    answers: [],
    run: (home, typed) => syncJourney(true, home, typed),
    finalState: (state) => state,
  },
  setupJourney,
  syncConflictStory,
  authorPublishJourney,
  listDisableJourney,
  listInvocationJourney,
  authJourney,
  collectionLifecycleJourney,
];
