import { skitConfigurationLayer } from "@smolai/skit-core";
import { Library } from "@smolai/skit-core/library";
import { Option, Effect } from "effect";
import { Command } from "effect/cli";
import { handleLibraryCommand } from "../commands/handler.js";
import { CommandMetadata } from "../commands/metadata.js";
import { historyOutputContracts } from "./history/output.js";
import { homeFlag, jsonFlag } from "../commands/parameters.js";
import { Renderer } from "../terminal/renderer.js";
import { encodeResult as result } from "../commands/encode-result.js";

export const libraryHistoryCliCommand = Command.make(
  "history",
  { json: jsonFlag, home: homeFlag },
  (input) =>
    handleLibraryCommand(
      Effect.gen(function* () {
        const library = yield* Library.Service;
        const renderer = yield* Renderer;
        const { events } = yield* library.history;
        yield* renderer.result(
          result("libraryHistory", historyOutputContracts.libraryHistory, { events }),
        );
      }),
    ).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(input.home)))),
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

export { historyOutputContracts } from "./history/output.js";
export { renderLibraryHistory } from "./history/present.js";
