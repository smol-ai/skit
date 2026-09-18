import { LibraryStore } from "@smolai/skit-core";
import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { handleCommand } from "../../application.js";
import { libraryCommandConfiguration } from "../../commands/library-configuration.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homePath, localFlags } from "../../commands/parameters.js";
import { Renderer } from "../../presentation/renderer.js";
import { executePortablePinEffect } from "../../workflows/library/portable-pin.js";
import { result } from "../contracts.js";

const subject = Argument.string("skit-or-skill");
const version = Flag.string("version").pipe(
  Flag.withDescription("Select a retained Version ID or historical Registry release."),
);
const dryRun = Flag.boolean("dry-run").pipe(
  Flag.withDescription("Acquire and verify the release without applying it."),
  Flag.withDefault(false),
);

export const pinCliCommand = Command.make(
  "pin",
  { subject, version, dryRun, ...localFlags },
  (input) =>
    handleCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const configuration = yield* libraryCommandConfiguration(input);
        const store = yield* LibraryStore;
        const portable = yield* store.load;
        const outcome = yield* renderer.withStatus(
          input.dryRun ? "Planning retained Version selection" : "Selecting retained Version",
          executePortablePinEffect(portable, {
            query: input.subject,
            version: input.version,
            dryRun: input.dryRun,
            roots: configuration.inventory,
            variantsPath: configuration.pull.bindings.variantsPath,
          }),
        );
        if (outcome.kind === "plan")
          return yield* renderer.result(result("pin", outputContracts.pinPlan, outcome.value));
        yield* renderer.result(result("pin", outputContracts.pin, outcome.value));
      }),
      homePath(input.home),
    ),
).pipe(
  Command.withDescription("Select an already-retained Library Version."),
  Command.withExamples([{ command: "skit pin owner/tools --version 2.0.0 --dry-run" }]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.pin, outputContracts.pinPlan],
    exitCodes: [0, 11, 12, 64, 65],
    interactive: false,
  }),
);
