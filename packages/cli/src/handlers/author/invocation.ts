import { generateInvocationMetadataEffect } from "@smolai/skit-core";
import { Effect, Option } from "effect";
import { resolve } from "node:path";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { handleCommand } from "../../application.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { jsonFlag } from "../../commands/parameters.js";
import { Renderer } from "../../presentation/renderer.js";
import { result } from "../contracts.js";

export const authorInvocationCommand = Effect.fn("CLI.authorInvocation")(function* (
  input: string,
  dryRun: boolean,
) {
  const root = resolve(input);
  const generated = yield* generateInvocationMetadataEffect(root, { dryRun });
  return { root, dryRun, generated };
});

const path = Argument.string("path").pipe(Argument.optional);
const dryRunFlag = Flag.boolean("dry-run").pipe(
  Flag.withDescription("Report the metadata that would change without writing it."),
  Flag.withDefault(false),
);

export const authorInvocationCliCommand = Command.make(
  "invocation",
  { path, dryRun: dryRunFlag, json: jsonFlag },
  ({ path, dryRun }) =>
    handleCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const { root, generated } = yield* authorInvocationCommand(
          Option.getOrElse(path, () => "."),
          dryRun,
        );
        yield* renderer.result(
          result("authorInvocation", outputContracts.authorInvocation, {
            path: root,
            dryRun,
            generated,
          }),
        );
      }),
    ),
).pipe(
  Command.withDescription(
    "Write each contained Skill's declared invocation policy into its Harness metadata.",
  ),
  Command.withExamples([
    { command: "skit author invocation" },
    { command: "skit author invocation ./my-tools --dry-run" },
    { command: "skit author invocation ./my-tools --json" },
  ]),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.write"] },
    outputSchemas: [outputContracts.authorInvocation],
    exitCodes: [0, 12, 64, 65],
    interactive: false,
  }),
);
