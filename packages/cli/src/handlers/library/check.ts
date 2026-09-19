import { Effect, Option } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { LibraryStore } from "@smolai/skit-core";
import { Renderer } from "../../presentation/renderer.js";
import { handleCommand } from "../../application.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homePath, localFlags } from "../../commands/parameters.js";
import { result } from "../contracts.js";
import { checkSubjectsEffect } from "../../workflows/library/check.js";

const subject = Argument.string("skit-or-skill").pipe(Argument.optional);

export const checkCliCommand = Command.make("check", { subject, ...localFlags }, (input) => {
  const selectedHome = homePath(input.home);
  return handleCommand(
    Effect.gen(function* () {
      const renderer = yield* Renderer;
      const store = yield* LibraryStore;
      const state = yield* store.load;
      const value = yield* renderer.withStatus(
        "Checking retained Collection custody",
        checkSubjectsEffect(state, {}, Option.getOrUndefined(input.subject), (collection) =>
          renderer.updateStatus(`Checking ${collection.display_name}`),
        ),
      );
      yield* renderer.result(result("check", outputContracts.check, value));
    }),
    selectedHome,
  );
}).pipe(
  Command.withDescription("Check retained Library custody or verified source changes."),
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
    outputSchemas: [outputContracts.check],
    exitCodes: [0, 11, 12, 64, 65],
    interactive: false,
  }),
);
