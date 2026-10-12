import { withCommandPaths } from "../../configuration/paths.js";
import { LibraryStore } from "@smolai/skit-core";
import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { handleLibraryCommand } from "../../application.js";
import { libraryCommandConfiguration } from "../../commands/library-configuration.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { localFlags } from "../../commands/parameters.js";
import { Renderer } from "../../presentation/renderer.js";
import { executeRemoveEffect } from "../../workflows/library/remove.js";
import { result } from "../contracts.js";

const subject = Argument.String("skit-or-skill");
const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Report removals without applying them."),
  Flag.withDefault(false),
);

export const removeCliCommand = Command.make(
  "remove",
  { subject, dryRun, ...localFlags },
  (input) =>
    withCommandPaths(input.home, (paths) =>
      handleLibraryCommand(
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          const configuration = yield* libraryCommandConfiguration(input);
          const store = yield* LibraryStore;
          const state = yield* store.load;
          const outcome = yield* renderer.withStatus(
            input.dryRun ? "Planning Collection removal" : "Removing retained Collection",
            executeRemoveEffect(state, {
              query: input.subject,
              dryRun: input.dryRun,
              variantsPath: configuration.pull.bindings.variantsPath,
            }),
          );
          if (outcome.kind === "plan")
            return yield* renderer.result(
              result("remove", outputContracts.removePlan, outcome.value),
            );
          yield* renderer.result(result("remove", outputContracts.remove, outcome.value));
        }),
        paths.skitHome,
      ),
    ),
).pipe(
  Command.withDescription("Remove a retained Collection and its owned Projections."),
  Command.withExamples([{ command: "skit remove owner/tools --dry-run" }]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.remove, outputContracts.removePlan],
    exitCodes: [0, 11, 12, 64, 65],
    interactive: false,
  }),
);
