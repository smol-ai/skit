import { Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";
import { Renderer } from "../terminal/renderer.js";
import { handleSourceCommand } from "../application.js";
import { CommandMetadata } from "./metadata.js";
import { checkOutputContracts } from "../library/check/output.js";
import * as Library from "@smolai/skit-core/library";
import { inspectLibrarySource } from "../library/source.js";
import { localFlags } from "./parameters.js";
import { encodeResult as result } from "./encode-result.js";

const subject = Argument.String("skill-or-collection").pipe(Argument.optional);

export const checkCliCommand = Command.make("check", { subject, ...localFlags }, (input) =>
  handleSourceCommand(
    Effect.gen(function* () {
      const renderer = yield* Renderer;
      const library = yield* Library.Service;
      const value = yield* renderer.withStatus(
        "Checking retained Collections",
        library.check(Option.getOrUndefined(input.subject), {
          inspectSource: inspectLibrarySource,
          onCollection: (collection) =>
            renderer.updateStatus(`Checking ${collection.display_name}`),
        }),
      );
      yield* renderer.result(result("check", checkOutputContracts.check, value));
    }),
    input,
  ),
).pipe(
  Command.withDescription("Check the Library's stored files and whether their sources changed."),
  Command.withExamples([{ command: "skit check" }, { command: "skit check owner/tools" }]),
  Command.annotate(CommandMetadata, {
    effects: {
      capabilities: ["filesystem.read", "filesystem.write", "network.read", "process.execute"],
      subprocesses: [
        "git clone --mirror",
        "git fetch --all --prune",
        "git rev-parse",
        "git ls-tree",
        "git cat-file blob",
        "git log",
      ],
    },
    outputSchemas: [checkOutputContracts.check],
    exitCodes: [0, 11, 12, 64, 65],
    interactive: false,
  }),
);
