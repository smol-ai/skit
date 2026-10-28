import { skitConfigurationLayer } from "../../configuration/skit-configuration.js";
import { terminalLibraryProgressLayer } from "../../presentation/library-progress.js";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { handleSourceCommand } from "../../application.js";
import { libraryCommandConfiguration } from "../../commands/library-configuration.js";
import {
  CommandMetadata,
  credentialStoreReadSubprocesses,
  sourceFetchSubprocesses,
} from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { localFlags } from "../../commands/parameters.js";
import { Renderer } from "../../presentation/renderer.js";
import { result } from "../contracts.js";
import { planUpdates, updateSubjects, updateExitCode } from "../../library-application/update.js";
import { prepareEditImport, EditImportMissing } from "../../workflows/library/import-edit.js";

const subject = Argument.String("skill-or-collection").pipe(Argument.optional);
const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Report changes without applying them."),
  Flag.withDefault(false),
);
const fromProjection = Flag.String("from-projection").pipe(
  Flag.withDescription("Import edits from this installed skill, given by its ID, harness or path."),
  Flag.optional,
);

export const updateCliCommand = Command.make(
  "update",
  { subject, dryRun, fromProjection, ...localFlags },
  (input) =>
    handleSourceCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const query = Option.getOrUndefined(input.subject);
        const projectionSelector = Option.getOrUndefined(input.fromProjection);
        if (projectionSelector !== undefined) {
          if (query === undefined)
            return yield* new EditImportMissing({
              message: "A Skill is required with --from-projection",
            });
          const value = yield* renderer.withStatus(
            input.dryRun
              ? "Inspecting changed installed-skill bytes"
              : "Retaining changed installed-skill bytes",
            Effect.gen(function* () {
              const prepared = yield* prepareEditImport(query, projectionSelector);
              return input.dryRun
                ? result("projectionRetentionPlan", prepared.preview)
                : result("projectionRetention", yield* prepared.apply());
            }),
          );
          return yield* renderer.result(value);
        }
        if (input.dryRun) {
          const value = yield* renderer.withStatus(
            "Checking Source observations",
            planUpdates(query),
          );
          return yield* renderer.result(result("updatePlan", value));
        }
        const configuration = yield* libraryCommandConfiguration(input);
        const value = yield* updateSubjects({ roots: configuration.inventory }, query).pipe(
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
    effects: {
      capabilities: ["filesystem.read", "filesystem.write", "network.read", "process.execute"],
      subprocesses: [...sourceFetchSubprocesses, ...credentialStoreReadSubprocesses],
    },
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
