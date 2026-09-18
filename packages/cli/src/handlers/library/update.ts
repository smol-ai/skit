import { Effect, Option } from "effect";
import { LibraryStore } from "@smolai/skit-core";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { handleCommand } from "../../application.js";
import { libraryCommandConfiguration } from "../../commands/library-configuration.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homePath, localFlags } from "../../commands/parameters.js";
import { Renderer } from "../../presentation/renderer.js";
import { result } from "../contracts.js";
import {
  planPortableUpdatesEffect,
  updatePortableCollectionsEffect,
} from "../../workflows/library/portable-update.js";
import {
  applyProjectionRetention,
  planProjectionRetention,
  ProjectionRetentionMissing,
} from "../../workflows/library/projection-retention.js";

const subject = Argument.string("skit-or-skill").pipe(Argument.optional);
const dryRun = Flag.boolean("dry-run").pipe(
  Flag.withDescription("Report changes without applying them."),
  Flag.withDefault(false),
);
const fromProjection = Flag.string("from-projection").pipe(
  Flag.withDescription("Retain changed bytes from this Projection ID, Harness, or path."),
  Flag.optional,
);

export const updateCliCommand = Command.make(
  "update",
  { subject, dryRun, fromProjection, ...localFlags },
  (input) =>
    handleCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const configuration = yield* libraryCommandConfiguration(input);
        const query = Option.getOrUndefined(input.subject);
        const projectionSelector = Option.getOrUndefined(input.fromProjection);
        const store = yield* LibraryStore;
        const portable = yield* store.load;
        const options = {
          roots: configuration.inventory,
          variantsPath: configuration.pull.bindings.variantsPath,
        };
        if (projectionSelector !== undefined) {
          if (query === undefined)
            return yield* new ProjectionRetentionMissing({
              message: "A Skill is required with --from-projection",
            });
          if (input.dryRun) {
            const value = yield* renderer.withStatus(
              "Inspecting changed Projection bytes",
              planProjectionRetention(portable, options, query, projectionSelector),
            );
            return yield* renderer.result(
              result("update", outputContracts.projectionRetentionPlan, value),
            );
          }
          const value = yield* renderer.withStatus(
            "Retaining changed Projection bytes",
            applyProjectionRetention(portable, options, query, projectionSelector),
          );
          return yield* renderer.result(
            result("update", outputContracts.projectionRetention, value),
          );
        }
        if (input.dryRun) {
          const value = yield* renderer.withStatus(
            "Checking Source observations",
            planPortableUpdatesEffect(portable, options, query),
          );
          return yield* renderer.result(result("update", outputContracts.updatePlan, value));
        }
        const value = yield* updatePortableCollectionsEffect(portable, options, query);
        yield* renderer.result(result("update", outputContracts.update, value));
      }),
      homePath(input.home),
    ),
).pipe(
  Command.withDescription("Update sources from their recorded origins."),
  Command.withExamples([
    { command: "skit update --dry-run" },
    { command: "skit update my-skill --from-projection claude-code --dry-run" },
  ]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [
      outputContracts.update,
      outputContracts.updatePlan,
      outputContracts.projectionRetention,
      outputContracts.projectionRetentionPlan,
    ],
    exitCodes: [0, 11, 12, 64, 65],
    interactive: false,
  }),
);
