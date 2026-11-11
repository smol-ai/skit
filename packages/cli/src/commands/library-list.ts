import { defineCommand } from "./definition.js";
import * as Library from "@smolai/skit-core/library";

import { Effect } from "effect";
import { Command } from "effect/cli";

import { CommandMetadata } from "./metadata.js";
import { listOutputContracts, browseLibrary, presentListCommand } from "../library/list.js";
import { localFlags } from "./parameters.js";
import { promptsAllowed } from "../terminal/interactivity.js";

export const listCliCommand = defineCommand("list", localFlags, (input) =>
  Effect.gen(function* () {
    const interactive = promptsAllowed({
      json: input.json,
      needsStdout: true,
    });
    if (!interactive) return yield* presentListCommand();
    const library = yield* Library.Service;
    const session = yield* library.session.open();
    yield* browseLibrary(session);
  }),
).pipe(
  Command.withDescription(
    "Browse the Skills and Collections in your Library and choose what is enabled.",
  ),
  Command.withExamples([{ command: "skit list" }, { command: "skit list --json" }]),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.read", "filesystem.write"] },
    outputSchemas: [listOutputContracts.list],
    interactive: true,
  }),
);
