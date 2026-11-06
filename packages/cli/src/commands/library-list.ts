import { SkitConfiguration } from "@smolai/skit-core/platform";
import { openLibrarySession } from "@smolai/skit-core/library/session";
import { Option, Effect } from "effect";
import { Command } from "effect/cli";
import { handleLibraryCommand } from "../application.js";
import { CommandMetadata } from "./metadata.js";
import { listOutputContracts, browseLibrary, presentListCommand } from "../library/list.js";
import { localFlags } from "./parameters.js";
import { libraryCommandConfiguration } from "./library-configuration.js";
import { promptsAllowed } from "../terminal/interactivity.js";

export const listCliCommand = Command.make("list", localFlags, (input) =>
  handleLibraryCommand(
    Effect.gen(function* () {
      const interactive = promptsAllowed({
        json: input.json,
        needsStdout: true,
      });
      if (!interactive) return yield* presentListCommand();
      const configuration = yield* libraryCommandConfiguration(input);
      const session = yield* Effect.flatMap(SkitConfiguration, (paths) =>
        openLibrarySession(paths.skitHome, configuration.pull.installOptions),
      );
      yield* browseLibrary(session, configuration.pull.installOptions);
    }),
    Option.getOrUndefined(input.home),
  ),
).pipe(
  Command.withDescription(
    "Browse the Skills and Collections in your Library and choose what is enabled.",
  ),
  Command.withExamples([{ command: "skit list" }, { command: "skit list --json" }]),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.read", "filesystem.write"] },
    outputSchemas: [listOutputContracts.list],
    exitCodes: [0, 12, 64, 65],
    interactive: true,
  }),
);
