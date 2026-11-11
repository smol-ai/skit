import { ConfigProvider, Effect, Layer } from "effect";
import { join } from "node:path";
import * as Library from "@smolai/skit-core/library";
import { skitConfigurationLayer, skitLayer } from "@smolai/skit-core/platform";
import { makeSetupJourneyFixture } from "../platform/setup-journey-fixture.js";
import { setupCommand } from "../library/setup.js";
import type { JourneyStory } from "./journey-stories.js";
import type { Prompter } from "../terminal/prompter.js";
import type { Renderer } from "../terminal/renderer.js";
import type { TypeCommand } from "./interaction-recorder.js";

/** Guided `skit setup` on a machine whose agents already have skills installed. */
const guidedSetup = (journeyHome: string, typed: TypeCommand) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { home, skillsStateHome, inventory, unselectedKept } =
        yield* makeSetupJourneyFixture(journeyHome);
      return yield* Effect.gen(function* () {
        yield* typed("skit setup");
        yield* setupCommand({
          options: { libraryHome: home, inventory, probePath: "", skillsStateHome },
          interactive: true,
          dryRun: false,
          manageOptions: { installOptions: inventory },
        });
        const library = yield* Library.Service;
        const after = yield* library.read;
        if (after._tag !== "Present") return yield* Effect.die("Expected setup to save a Library");
        const { skills, enabled, installed_skills } = after.state;
        if (!(yield* unselectedKept) || skills.some((skill) => skill.name === "asb-positioning"))
          return yield* Effect.die("Setup touched the skill left unselected");
        const agents = new Set(installed_skills.map((copy) => copy.destination)).size;
        return `${skills.length} Skills in the Library | ${enabled.length} enabled | ${installed_skills.length} installed copies across ${agents} agents | asb-positioning left as it was`;
      }).pipe(
        Effect.provide(
          Library.layer({ home, roots: inventory }).pipe(
            Layer.provideMerge(skitConfigurationLayer(home)),
            Layer.provideMerge(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  CODEX_HOME: join(inventory.home, ".codex"),
                  CLAUDE_CONFIG_DIR: join(inventory.home, ".claude"),
                }),
              ),
            ),
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(skitLayer));

export const setupJourney: JourneyStory<
  string,
  Effect.Error<ReturnType<typeof guidedSetup>>,
  Prompter | Renderer
> = {
  _tag: "Journey",
  name: "setup/guided-existing-skills",
  description: "Choose which existing skills SKIT should manage during guided setup.",
  initialState:
    "No SKIT Library | 5 real skills in ~/.agents/skills and ~/.claude/skills | 1 shared by symlink",
  answers: [
    // Bring four skills under SKIT and leave asb-positioning as it is.
    { labels: ["cli-ux", "skill-cutter", "asb-problem", "nvidia-skill-finder"] },
    true,
  ],
  run: guidedSetup,
  finalState: (state) => state,
};
