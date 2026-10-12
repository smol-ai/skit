import { skitPathsLayer } from "../../configuration/paths.js";
import { LibraryAuditLog } from "@smolai/skit-core";
import { Option, Effect } from "effect";
import { Command } from "effect/cli";
import { handleLibraryCommand } from "../../application.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homeFlag, jsonFlag } from "../../commands/parameters.js";
import { Renderer } from "../../presentation/renderer.js";
import { result } from "../contracts.js";

export const libraryHistoryCliCommand = Command.make(
  "history",
  { json: jsonFlag, home: homeFlag },
  (input) =>
    handleLibraryCommand(
      Effect.gen(function* () {
        const audit = yield* LibraryAuditLog;
        const renderer = yield* Renderer;
        const events = yield* audit.list();
        yield* renderer.result(
          result("libraryHistory", outputContracts.libraryHistory, { events }),
        );
      }),
    ).pipe(Effect.provide(skitPathsLayer(Option.getOrUndefined(input.home)))),
).pipe(
  Command.withDescription("Show device-local Library change history."),
  Command.withExamples([
    { command: "skit library history" },
    { command: "skit library history --json" },
  ]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.libraryHistory],
    exitCodes: [0, 65],
    interactive: false,
  }),
);
