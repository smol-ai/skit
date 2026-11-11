import { defineCommand } from "./definition.js";
import { Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";
import { Renderer } from "../terminal/renderer.js";

import { CommandMetadata } from "./metadata.js";
import { checkOutputContracts } from "../library/check/output.js";
import * as Library from "@smolai/skit-core/library";
import { inspectLibrarySource } from "../library/source.js";
import { localFlags } from "./parameters.js";
import { encodeResult as result } from "./encode-result.js";

const subject = Argument.String("skill-or-collection").pipe(
  Argument.withDescription("Skill or Collection Reference to check; omit it to check the Library."),
  Argument.optional,
);

export const checkCliCommand = defineCommand("check", { subject, ...localFlags }, (input) =>
  Effect.gen(function* () {
    const renderer = yield* Renderer;
    const library = yield* Library.Service;
    const value = yield* renderer.withStatus(
      "Checking Collections in the Library",
      library.check(Option.getOrUndefined(input.subject), {
        inspectSource: inspectLibrarySource,
        onCollection: (collection) => renderer.updateStatus(`Checking ${collection.display_name}`),
      }),
    );
    yield* renderer.result(result("check", checkOutputContracts.check, value));
  }),
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
    interactive: false,
  }),
);
