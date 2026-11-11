import { Block } from "../terminal/blocks.js";
import { ConfigProvider, Effect, Layer } from "effect";
import { join } from "node:path";
import * as Library from "@smolai/skit-core/library";
import { skitConfigurationLayer, skitLayer } from "@smolai/skit-core/platform";
import { makeCollectionLifecycleFixture } from "../platform/collection-lifecycle-fixture.js";
import { addSourceRequest } from "../registry/library-source.js";
import { addOutputContracts } from "../library/add/output.js";
import { descriptionLoadMessage } from "../library/presentation/description-size.js";
import { presentSetEnabled } from "../library/enable.js";
import { removeOutputContracts } from "../library/remove/output.js";
import { encodeResult } from "../commands/encode-result.js";
import { commandFailure } from "../commands/failure-classification.js";
import { Renderer } from "../terminal/renderer.js";
import { compactHome } from "../terminal/home-path.js";
import type { JourneyStory } from "./journey-stories.js";
import type { TypeCommand } from "./interaction-recorder.js";

/**
 * A local folder of skills through its whole life in the Library: added, enabled everywhere on
 * the device through enable's prompts, then removed with the copies SKIT installed from it.
 */
const addEnableRemove = (journeyHome: string, typed: TypeCommand) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { source, home, inventory, skillsAt, sourceKept } =
        yield* makeCollectionLifecycleFixture(journeyHome);
      const renderer = yield* Renderer;
      return yield* Effect.gen(function* () {
        const library = yield* Library.Service;

        yield* typed(`skit add ${source}`);
        const { added, descriptionLoad } = yield* renderer.withStatus(
          "Adding source",
          library.addSource(yield* addSourceRequest(source)),
        );
        yield* renderer.result(encodeResult("add", addOutputContracts.add, added));
        yield* renderer.note(
          [
            Block.Note({
              text: [
                descriptionLoad === undefined
                  ? "Description size unavailable."
                  : descriptionLoadMessage(descriptionLoad),
              ],
            }),
          ],
          "Description size",
        );
        const afterAdd = yield* library.read;
        if (
          afterAdd._tag !== "Present" ||
          afterAdd.state.collections.length !== 1 ||
          afterAdd.state.skills.length !== 2 ||
          afterAdd.state.enabled.length !== 0 ||
          afterAdd.state.installed_skills.length !== 0
        )
          return yield* Effect.die(
            "Expected add to keep two Skills in the Library, none installed",
          );

        yield* typed("skit enable");
        yield* presentSetEnabled({
          action: "enable",
          enabled: true,
          cwd: journeyHome,
          all: false,
          dryRun: false,
          interactive: true,
        });
        const afterEnable = yield* library.read;
        if (afterEnable._tag !== "Present")
          return yield* Effect.die("Expected enable to keep the Library");
        const copies = afterEnable.state.installed_skills;
        const onDisk = yield* skillsAt(copies.map((copy) => copy.path));
        if (
          copies.length === 0 ||
          copies.some((copy) => copy.status !== "installed") ||
          onDisk.includes(false) ||
          new Set(copies.map((copy) => copy.skill_id)).size !== 2
        )
          return yield* Effect.die("Expected enable to install both Skills where a harness reads");
        const folders = [...new Set(copies.map((copy) => copy.root))];

        yield* typed("skit remove swyx-skills");
        const outcome = yield* renderer.withStatus(
          "Removing Collection from the Library",
          library.remove({ query: "swyx-skills", dryRun: false }),
        );
        if (outcome.kind === "plan")
          return yield* Effect.die("Expected remove to apply, not to plan");
        yield* renderer.result(encodeResult("remove", removeOutputContracts.remove, outcome.value));
        const afterRemove = yield* library.read;
        const left = yield* skillsAt(copies.map((copy) => copy.path));
        if (
          afterRemove._tag !== "Present" ||
          afterRemove.state.collections.length !== 0 ||
          afterRemove.state.skills.length !== 0 ||
          afterRemove.state.installed_skills.length !== 0 ||
          left.includes(true) ||
          !(yield* sourceKept) ||
          outcome.value.uninstalled !== copies.length
        )
          return yield* Effect.die(
            "Expected remove to drop the Collection and its installed copies",
          );
        return `Library empty | ${copies.length} installed copies gone from ${compactHome(folders.join(", "), journeyHome)} | ~/dev/swyx-skills keeps both skills`;
      }).pipe(
        Effect.provide(
          Library.layer({ home, roots: inventory }).pipe(
            Layer.provideMerge(skitConfigurationLayer(home)),
            Layer.provideMerge(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  CODEX_HOME: join(inventory.home, ".codex"),
                  CLAUDE_CONFIG_DIR: join(inventory.home, ".claude"),
                  XDG_CONFIG_HOME: inventory.configHome,
                  XDG_STATE_HOME: join(inventory.home, ".local", "state"),
                }),
              ),
            ),
          ),
        ),
        Effect.catchCause((cause) =>
          renderer.failure(commandFailure(cause)).pipe(Effect.andThen(Effect.failCause(cause))),
        ),
      );
    }),
  ).pipe(Effect.provide(skitLayer));

export const collectionLifecycleJourney: JourneyStory<
  string,
  Effect.Error<ReturnType<typeof addEnableRemove>>,
  Effect.Services<ReturnType<typeof addEnableRemove>>
> = {
  _tag: "Journey",
  name: "library/add-enable-remove",
  description:
    "Add a local collection, enable its skills, then remove it from the Library while keeping the original files.",
  initialState: "No SKIT Library | ~/dev/swyx-skills holds 2 real skills (cli-ux, skill-cutter)",
  answers: [{ label: "swyx-skills" }, "collection", "global"],
  run: addEnableRemove,
  finalState: (state) => state,
};
