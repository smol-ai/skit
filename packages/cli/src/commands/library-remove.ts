import { Option, Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { handleLibraryCommand } from "../application.js";
import { CommandMetadata } from "./metadata.js";
import { removeOutputContracts } from "../library/remove/output.js";
import { removeCollection } from "@smolai/skit-core/library/remove";
import { localFlags } from "./parameters.js";
import { Renderer } from "../terminal/renderer.js";

import { encodeResult as result } from "./encode-result.js";

const subject = Argument.String("skill-or-collection");

const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Report removals without applying them."),
  Flag.withDefault(false),
);

export const removeCliCommand = Command.make(
  "remove",
  { subject, dryRun, ...localFlags },
  (input) =>
    handleLibraryCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const outcome = yield* renderer.withStatus(
          input.dryRun ? "Planning Collection removal" : "Removing retained Collection",
          removeCollection({
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
      Option.getOrUndefined(input.home),
    ),
).pipe(
  Command.withDescription(
    "Remove a Collection from your Library and the skills SKIT installed from it.",
  ),
  Command.withExamples([{ command: "skit remove owner/tools --dry-run" }]),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.read", "filesystem.write"] },
    outputSchemas: [removeOutputContracts.remove, removeOutputContracts.removePlan],
    exitCodes: [0, 11, 12, 64, 65],
    interactive: false,
  }),
);
