import { defineCommand } from "./definition.js";
import * as Library from "@smolai/skit-core/library";
import { Effect } from "effect";
import { Command } from "effect/cli";

import { CommandMetadata } from "./metadata.js";
import { historyOutputContracts } from "../library/history/output.js";
import { jsonFlag } from "./parameters.js";
import { Renderer } from "../terminal/renderer.js";
import { encodeResult as result } from "./encode-result.js";

export const libraryHistoryCliCommand = defineCommand("history", { json: jsonFlag }, () =>
  Effect.gen(function* () {
    const renderer = yield* Renderer;
    const library = yield* Library.Service;
    const { events } = yield* library.history;
    yield* renderer.result(
      result("libraryHistory", historyOutputContracts.libraryHistory, {
        events,
      }),
    );
  }),
).pipe(
  Command.withDescription("Show device-local Library change history."),
  Command.withExamples([
    { command: "skit library history" },
    { command: "skit library history --json" },
  ]),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.read"] },
    outputSchemas: [historyOutputContracts.libraryHistory],
    interactive: false,
  }),
);
