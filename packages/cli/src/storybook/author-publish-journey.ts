import { ConfigProvider, Effect, Layer } from "effect";
import { join } from "node:path";
import * as Library from "@smolai/skit-core/library";
import { authorLayer } from "@smolai/skit-core/author";
import { skitConfigurationLayer, skitLayer } from "@smolai/skit-core/platform";
import {
  authorPublishOrigin,
  makeAuthorPublishFixture,
} from "../platform/author-publish-fixture.js";
import { authorInitCommand } from "../author/init.js";
import { validateCommand } from "../author/validate.js";
import { authorSyncCommand } from "../author/sync.js";
import { publishCommand } from "../author/publish.js";
import { result } from "../commands/result.js";
import { commandFailure } from "../commands/failure-classification.js";
import { Renderer } from "../terminal/renderer.js";
import type { JourneyStory } from "./journey-stories.js";
import type { TypeCommand } from "./interaction-recorder.js";

/**
 * A person's authoring path, from a folder holding one real skill to a published Release, run by
 * the real author commands against disposable homes and an in-memory Registry.
 */
const initToPublish = (journeyHome: string, typed: TypeCommand) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { workspace, home, account, registry } = yield* makeAuthorPublishFixture(journeyHome);
      const renderer = yield* Renderer;
      return yield* Effect.gen(function* () {
        yield* typed("skit author init");
        const { initialized } = yield* authorInitCommand(workspace);
        yield* renderer.result(
          result("init", { ...initialized, library_registration: "registered" }),
        );
        yield* typed("skit author validate");
        const { value, status } = yield* validateCommand(workspace, "author");
        yield* renderer.result(
          result("validate", {
            valid: status === "valid" || status === "valid-with-warnings",
            status,
            identity: value.identity,
            diagnostics: value.diagnostics,
            audits: value.audits,
            assessments: value.assessments,
          }),
        );
        // A first sync names its destination; the CLI requires --to with --visibility.
        for (const apply of [false, true]) {
          yield* typed(
            `skit author sync --to swyx/skill-cutter --visibility private${apply ? " --apply" : ""}`,
          );
          const synced = yield* authorSyncCommand({
            root: workspace,
            home,
            apply,
            to: "swyx/skill-cutter",
            visibility: "private",
          });
          yield* renderer.result(result("sync", synced));
        }
        yield* typed("skit author publish --version 1.0.0");
        const published = yield* publishCommand({ root: workspace, home, version: "1.0.0" });
        yield* renderer.result(result("publish", published));
        return `swyx/skill-cutter is private on the Registry | Release ${published.release.version} published`;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Library.layer({
              home,
              roots: {
                home: account,
                configHome: join(account, ".config"),
                overrides: { codex: [join(account, ".agents", "skills")] },
              },
            }),
            authorLayer({ home }),
          ).pipe(
            Layer.provideMerge(
              skitConfigurationLayer(home).pipe(
                // The fixture Registry's credential, given to this command alone.
                Layer.provide(
                  ConfigProvider.layer(
                    ConfigProvider.fromUnknown({
                      SKIT_SERVER_URL: authorPublishOrigin,
                      SKIT_TOKEN: "fixture",
                    }),
                  ),
                ),
              ),
            ),
            Layer.provideMerge(registry),
          ),
        ),
        Effect.catchCause((cause) =>
          renderer.failure(commandFailure(cause)).pipe(Effect.andThen(Effect.failCause(cause))),
        ),
      );
    }),
  ).pipe(Effect.provide(skitLayer));

export const authorPublishJourney: JourneyStory<
  string,
  Effect.Error<ReturnType<typeof initToPublish>>,
  Effect.Services<ReturnType<typeof initToPublish>>
> = {
  _tag: "Journey",
  name: "author/init-to-publish",
  description: "Create a collection from an existing skill and publish its first release.",
  initialState: "A folder holding one real skill (swyxio/skill-cutter) | empty Registry",
  answers: [],
  run: initToPublish,
  finalState: (state) => state,
};
