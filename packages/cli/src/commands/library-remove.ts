import { defineCommand } from "./definition.js";
import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { CommandMetadata } from "./metadata.js";
import { removeOutputContracts } from "../library/remove/output.js";
import * as Library from "@smolai/skit-core/library";
import { localFlags } from "./parameters.js";
import { Renderer } from "../terminal/renderer.js";

import { encodeResult as result } from "./encode-result.js";

const subject = Argument.String("skill-or-collection").pipe(
  Argument.withDescription("Skill or Collection Reference to remove from the Library."),
);

const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Report removals without applying them."),
  Flag.withDefault(false),
);

export const removeCliCommand = defineCommand(
  "remove",
  { subject, dryRun, ...localFlags },
  (input) =>
    Effect.gen(function* () {
      const renderer = yield* Renderer;
      const library = yield* Library.Service;
      const outcome = yield* renderer.withStatus(
        input.dryRun ? "Planning Collection removal" : "Removing Collection from the Library",
        library.remove({
          query: input.subject,
          dryRun: input.dryRun,
        }),
      );
      if (outcome.kind === "plan")
        return yield* renderer.result(
          result("removePlan", removeOutputContracts.removePlan, outcome.value),
        );
      yield* renderer.result(result("remove", removeOutputContracts.remove, outcome.value));
    }),
).pipe(
  Command.withDescription(
    "Remove a Collection from your Library and the skills SKIT installed from it. Select an Author Workspace by its path; its authored files remain.",
  ),
  Command.withExamples([
    { command: "skit remove owner/tools --dry-run" },
    { command: "skit remove ~/dev/skills --dry-run" },
  ]),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.read", "filesystem.write"] },
    outputSchemas: [removeOutputContracts.remove, removeOutputContracts.removePlan],
    interactive: false,
  }),
);
