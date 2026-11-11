import { makeSyncConflictFixture, syncConflictOrigin } from "../platform/sync-conflict-fixture.js";
import { Effect, Result } from "effect";
import { skitLayer } from "@smolai/skit-core/platform";
import { librarySyncCommand } from "../library/sync.js";
import { result } from "../commands/result.js";
import { commandFailure } from "../commands/failure-classification.js";
import { Renderer } from "../terminal/renderer.js";
import type { JourneyStory } from "./journey-stories.js";
import type { TypeCommand } from "./interaction-recorder.js";

/** The desktop runs the real sync command, sees the conflict, and takes the remote version. */
export const syncConflictJourney = (journeyHome: string, typed: TypeCommand) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { desktop, syncDesktop, installedCliUx } = yield* makeSyncConflictFixture(journeyHome);
      const renderer = yield* Renderer;
      const run = (options: { readonly apply: boolean; readonly takeRemote?: readonly string[] }) =>
        typed(
          [
            "skit sync",
            ...(options.apply ? ["--apply"] : []),
            ...(options.takeRemote ?? []).map((key) => `--take-remote ${key}`),
          ].join(" "),
        ).pipe(
          Effect.andThen(
            librarySyncCommand({
              authState: Result.succeed({
                origin: syncConflictOrigin,
                token: "fixture",
                source: "stored",
              }),
              ...options,
            }),
          ),
          Effect.provide(desktop),
          Effect.catchCause((cause) =>
            renderer.failure(commandFailure(cause)).pipe(Effect.andThen(Effect.failCause(cause))),
          ),
          Effect.tap((synced) => renderer.result(result("librarySync", synced))),
        );
      // Preview first; then apply the resolution for exactly the keys the conflict names.
      const preview = yield* run({ apply: false });
      if (preview.status !== "conflicted" || !preview.conflicts?.length)
        return yield* Effect.die(`Expected a sync conflict, got ${preview.status}`);
      const resolved = yield* run({ apply: true, takeRemote: preview.conflicts });
      if (resolved.status !== "merged")
        return yield* Effect.die(`Expected the take-remote sync to merge, got ${resolved.status}`);
      const after = yield* syncDesktop;
      if (after.status !== "clean")
        return yield* Effect.die(`Expected the desktop to be in sync, got ${after.status}`);
      return (yield* installedCliUx).includes("Laptop: confirm before deleting.")
        ? "In sync | desktop has the laptop's cli-ux edit installed"
        : "In sync | desktop kept its installed cli-ux copy";
    }),
  ).pipe(Effect.provide(skitLayer));

export const syncConflictStory: JourneyStory<
  string,
  Effect.Error<ReturnType<typeof syncConflictJourney>>,
  Effect.Services<ReturnType<typeof syncConflictJourney>>
> = {
  _tag: "Journey",
  name: "library-sync/conflict-take-remote",
  description: "Resolve competing edits from two devices by taking the remote version.",
  initialState:
    "swyxio/skills synced on two devices | each device then changed cli-ux | laptop pushed first",
  answers: [],
  run: syncConflictJourney,
  finalState: (state) => state,
};
