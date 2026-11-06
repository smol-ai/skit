import { readLibraryHistory } from "@smolai/skit-core/library/queries";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { handleLibraryCommand } from "../application.js";
import { CommandMetadata } from "./metadata.js";
import { historyOutputContracts } from "../library/history/output.js";
import { homeFlag, jsonFlag } from "./parameters.js";
import { Renderer } from "../terminal/renderer.js";
import { encodeResult as result } from "./encode-result.js";

export const libraryHistoryCliCommand = Command.make(
  "history",
  { json: jsonFlag, home: homeFlag },
  (input) =>
    handleLibraryCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const { events } = yield* readLibraryHistory();
        yield* renderer.result(
          result("libraryHistory", historyOutputContracts.libraryHistory, {
            events,
          }),
        );
      }),
      input,
    ),
).pipe(
  Command.withDescription("Show device-local Library change history."),
  Command.withExamples([
    { command: "skit library history" },
    { command: "skit library history --json" },
  ]),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.read"] },
    outputSchemas: [historyOutputContracts.libraryHistory],
    exitCodes: [0, 64],
    interactive: false,
  }),
);
