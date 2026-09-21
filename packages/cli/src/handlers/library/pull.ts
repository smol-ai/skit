import { Effect } from "effect";
import { LibraryStore } from "@smolai/skit-core";
import { Argument, Command } from "effect/unstable/cli";
import { handleCommand } from "../../application.js";
import { libraryCommandConfiguration } from "../../commands/library-configuration.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homePath, localFlags } from "../../commands/parameters.js";
import { Renderer } from "../../presentation/renderer.js";
import { result } from "../contracts.js";
import { updateSubjectsEffect } from "../../workflows/library/update.js";

const subject = Argument.string("skit-or-skill");

export const pullCliCommand = Command.make("pull", { subject, ...localFlags }, (input) =>
  handleCommand(
    Effect.gen(function* () {
      const renderer = yield* Renderer;
      const configuration = yield* libraryCommandConfiguration(input);
      const store = yield* LibraryStore;
      const state = yield* store.load;
      const values = yield* updateSubjectsEffect(
        state,
        {
          roots: configuration.inventory,
          variantsPath: configuration.pull.bindings.variantsPath,
        },
        input.subject,
      );
      yield* renderer.result(result("pull", outputContracts.pull, values));
    }),
    homePath(input.home),
  ),
).pipe(
  Command.withDescription("Refresh a source already in the local library."),
  Command.withExamples([{ command: "skit pull owner/tools" }]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.pull],
    exitCodes: [0, 11, 12, 64, 65],
    interactive: false,
  }),
);
