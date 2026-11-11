import { Effect } from "effect";
import * as Library from "@smolai/skit-core/library";
import { skitLayer } from "@smolai/skit-core/platform";
import { makeListInvocationFixture } from "../platform/list-invocation-fixture.js";
import { browseLibrary } from "../library/list.js";
import { commandFailure } from "../commands/failure-classification.js";
import { Renderer } from "../terminal/renderer.js";
import type { JourneyStory } from "./journey-stories.js";
import type { TypeCommand } from "./interaction-recorder.js";

const changeInvocation = (journeyHome: string, typed: TypeCommand) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { layer, verifyApplied } = yield* makeListInvocationFixture(journeyHome);
      const renderer = yield* Renderer;
      return yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        yield* typed("skit list");
        yield* browseLibrary(yield* library.session.open());
        return yield* verifyApplied;
      }).pipe(
        Effect.provide(layer),
        Effect.catchCause((cause) =>
          renderer.failure(commandFailure(cause)).pipe(Effect.andThen(Effect.failCause(cause))),
        ),
      );
    }),
  ).pipe(Effect.provide(skitLayer));

export const listInvocationJourney: JourneyStory<
  string,
  Effect.Error<ReturnType<typeof changeInvocation>>,
  Effect.Services<ReturnType<typeof changeInvocation>>
> = {
  _tag: "Journey",
  name: "list-invocation/only-when-asked",
  description:
    "Review per-agent policy, then require an explicit invocation globally while keeping the repository's policy.",
  initialState: "cli-ux enabled globally and in ~/dev/app | skill-cutter enabled globally",
  answers: [
    { label: "swyxio/skills" },
    { label: "cli-ux | enabled" },
    "invocation",
    { label: "Everywhere on this device" },
    "explicit",
    true,
    "done",
  ],
  run: changeInvocation,
  finalState: (state) => state,
};
