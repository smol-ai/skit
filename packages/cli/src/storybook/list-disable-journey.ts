import { Effect } from "effect";
import * as Library from "@smolai/skit-core/library";
import { skitLayer } from "@smolai/skit-core/platform";
import { makeListDisableFixture } from "../platform/list-disable-fixture.js";
import { browseLibrary } from "../library/list.js";
import { presentSetEnabled } from "../library/enable.js";
import { commandFailure } from "../commands/failure-classification.js";
import { Renderer } from "../terminal/renderer.js";
import type { JourneyStory } from "./journey-stories.js";
import type { TypeCommand } from "./interaction-recorder.js";

/**
 * A person browses their Library, looks at cli-ux, then turns it off globally while keeping it
 * in the repository and keeping skill-cutter, through the real `list` and `disable` workflows.
 */
const browseThenDisable = (journeyHome: string, typed: TypeCommand) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { layer, repository, installed } = yield* makeListDisableFixture(journeyHome);
      const renderer = yield* Renderer;
      return yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        yield* typed("skit list");
        yield* browseLibrary(yield* library.session.open());
        const before = yield* library.read;
        yield* typed("skit disable");
        yield* presentSetEnabled({
          action: "disable",
          enabled: false,
          cwd: repository,
          all: false,
          dryRun: false,
          interactive: true,
        });
        const after = yield* library.read;
        if (before._tag !== "Present" || after._tag !== "Present")
          return yield* Effect.die("Expected a saved Library");
        const named = (name: string) =>
          after.state.skills.find((skill) => skill.name === name)?.skill_id;
        const cliUx = named("cli-ux");
        const skillCutter = named("skill-cutter");
        const globally = after.state.enabled.flatMap((item) =>
          "skill" in item ? [item.skill] : [],
        );
        const inRepository = after.state.repositories
          .filter((entry) => entry.root === repository)
          .flatMap((entry) => entry.enabled)
          .flatMap((item) => ("skill" in item ? [item.skill] : []));
        if (
          cliUx === undefined ||
          skillCutter === undefined ||
          globally.includes(cliUx) ||
          !globally.includes(skillCutter) ||
          !inRepository.includes(cliUx)
        )
          return yield* Effect.die(
            "Expected cli-ux disabled globally only, with skill-cutter still enabled",
          );
        if ((yield* installed.globalCliUx) || !(yield* installed.globalSkillCutter))
          return yield* Effect.die(
            "Expected only the global cli-ux copy removed from ~/.agents/skills",
          );
        if (
          !after.state.installed_skills.some(
            (copy) => copy.skill_id === cliUx && copy.path.startsWith(repository),
          )
        )
          return yield* Effect.die("Expected the repository's cli-ux copy to stay installed");
        return `cli-ux disabled globally, still enabled in ~/dev/app | skill-cutter still enabled globally | ${after.state.installed_skills.length} of ${before.state.installed_skills.length} installed copies remain`;
      }).pipe(
        Effect.provide(layer),
        Effect.catchCause((cause) =>
          renderer.failure(commandFailure(cause)).pipe(Effect.andThen(Effect.failCause(cause))),
        ),
      );
    }),
  ).pipe(Effect.provide(skitLayer));

export const listDisableJourney: JourneyStory<
  string,
  Effect.Error<ReturnType<typeof browseThenDisable>>,
  Effect.Services<ReturnType<typeof browseThenDisable>>
> = {
  _tag: "Journey",
  name: "list-disable/turn-off-one-skill",
  description:
    "Browse enabled skills, then turn off one skill everywhere while keeping it enabled in a repository.",
  initialState:
    "swyxio/skills in the Library | cli-ux and skill-cutter enabled globally | cli-ux also enabled in ~/dev/app",
  answers: [
    // skit list: open the Collection, look at cli-ux, then leave.
    { label: "swyxio/skills" },
    { label: "cli-ux | enabled" },
    "done",
    // skit disable: pick the global Scope, then cli-ux alone.
    { label: "swyxio/skills (GitHub: swyxio/skills) — global" },
    "skills",
    ["cli-ux"],
  ],
  run: browseThenDisable,
  finalState: (state) => state,
};
