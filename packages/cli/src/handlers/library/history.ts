import { LibraryAuditLog } from "@smolai/skit-core";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { handleReadOnlyCommand } from "../../application.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homeFlag, homePath, jsonFlag } from "../../commands/parameters.js";
import { Renderer } from "../../presentation/renderer.js";
import { result } from "../contracts.js";

export const libraryHistoryCliCommand = Command.make(
  "history",
  { json: jsonFlag, home: homeFlag },
  (input) => {
    const home = homePath(input.home);
    return handleReadOnlyCommand(
      Effect.gen(function* () {
        const audit = yield* LibraryAuditLog;
        const renderer = yield* Renderer;
        const events = yield* audit.list();
        yield* renderer.result(
          result("libraryHistory", outputContracts.libraryHistory, { events }),
        );
      }),
      home,
    );
  },
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
