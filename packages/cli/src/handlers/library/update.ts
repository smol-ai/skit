import { skitConfigurationLayer } from "../../configuration/skit-configuration.js";
import { terminalLibraryProgressLayer } from "../../presentation/library-progress.js";
import { Effect, Option } from "effect";
import { LibraryStore } from "@smolai/skit-core";
import { Argument, Command, Flag } from "effect/cli";
import { handleSourceCommand } from "../../application.js";
import { libraryCommandConfiguration } from "../../commands/library-configuration.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { localFlags } from "../../commands/parameters.js";
import { Renderer } from "../../presentation/renderer.js";
import { result } from "../contracts.js";
import {
  planUpdatesEffect,
  updateSubjectsEffect,
  updateExitCode,
} from "../../library-application/update.js";
import {
  applyProjectionRetention,
  planProjectionRetention,
  ProjectionRetentionMissing,
} from "../../workflows/library/projection-retention.js";

const subject = Argument.String("skit-or-skill").pipe(Argument.optional);
const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Report changes without applying them."),
  Flag.withDefault(false),
);
const fromProjection = Flag.String("from-projection").pipe(
  Flag.withDescription("Retain changed bytes from this Projection ID, Harness, or path."),
  Flag.optional,
);

export const updateCliCommand = Command.make(
  "update",
  { subject, dryRun, fromProjection, ...localFlags },
  (input) =>
    handleSourceCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const configuration = yield* libraryCommandConfiguration(input);
        const query = Option.getOrUndefined(input.subject);
        const projectionSelector = Option.getOrUndefined(input.fromProjection);
        const options = {
          roots: configuration.inventory,
        };
        if (projectionSelector !== undefined) {
          const store = yield* LibraryStore;
          const state = yield* store.load;
          if (query === undefined)
            return yield* new ProjectionRetentionMissing({
              message: "A Skill is required with --from-projection",
            });
          if (input.dryRun) {
            const value = yield* renderer.withStatus(
              "Inspecting changed Projection bytes",
              planProjectionRetention(state, options, query, projectionSelector),
            );
            return yield* renderer.result(result("projectionRetentionPlan", value));
          }
          const value = yield* renderer.withStatus(
            "Retaining changed Projection bytes",
            applyProjectionRetention(state, options, query, projectionSelector),
          );
          return yield* renderer.result(result("projectionRetention", value));
        }
        if (input.dryRun) {
          const value = yield* renderer.withStatus(
            "Checking Source observations",
            planUpdatesEffect(query),
          );
          return yield* renderer.result(result("updatePlan", value));
        }
        const value = yield* updateSubjectsEffect(options, query).pipe(
          Effect.provide(terminalLibraryProgressLayer),
        );
        yield* renderer.result(result("update", value, updateExitCode(value)));
      }),
    ).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(input.home)))),
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
    exitCodes: [0, 1, 11, 12, 64, 65],
    interactive: false,
  }),
);
