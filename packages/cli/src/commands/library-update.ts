import {
  updateOutputContracts,
  planUpdates,
  updateSubjects,
  updateExitCode,
  prepareEditImport,
  EditImportMissing,
} from "../library/update.js";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { handleSourceCommand } from "../application.js";
import { libraryCommandConfiguration } from "./library-configuration.js";
import {
  CommandMetadata,
  credentialStoreReadSubprocesses,
  sourceFetchSubprocesses,
} from "./metadata.js";

import { localFlags } from "./parameters.js";
import { Renderer } from "../terminal/renderer.js";
import { encodeResult as result } from "./encode-result.js";

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
        const installedSkillSelector = Option.getOrUndefined(input.fromProjection);
        if (installedSkillSelector !== undefined) {
          if (query === undefined)
            return yield* new EditImportMissing({
              message: "A Skill is required with --from-projection",
            });
          const value = yield* renderer.withStatus(
            input.dryRun
              ? "Inspecting changed installed-skill bytes"
              : "Retaining changed installed-skill bytes",
            Effect.gen(function* () {
              const prepared = yield* prepareEditImport(query, installedSkillSelector);
              return input.dryRun
                ? result(
                    "projectionRetentionPlan",
                    updateOutputContracts.projectionRetentionPlan,
                    prepared.preview,
                  )
                : result(
                    "projectionRetention",
                    updateOutputContracts.projectionRetention,
                    yield* prepared.apply(),
                  );
            }),
          );
          return yield* renderer.result(value);
        }
        if (input.dryRun) {
          const value = yield* renderer.withStatus(
            "Checking Source observations",
            planUpdates(query),
          );
          return yield* renderer.result(
            result("updatePlan", updateOutputContracts.updatePlan, value),
          );
        }
        const configuration = yield* libraryCommandConfiguration(input);
        const value = yield* updateSubjects({ roots: configuration.inventory }, query);
        yield* renderer.result(
          result("update", updateOutputContracts.update, value, updateExitCode(value)),
        );
      }),
      Option.getOrUndefined(input.home),
    ),
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
      updateOutputContracts.update,
      updateOutputContracts.updatePlan,
      updateOutputContracts.projectionRetention,
      updateOutputContracts.projectionRetentionPlan,
    ],
    exitCodes: [0, 1, 11, 12, 64, 65],
    interactive: false,
  }),
);
