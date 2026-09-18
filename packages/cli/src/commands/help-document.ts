import { Effect, Option, Schema } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import type { HelpDoc } from "effect/unstable/cli";

export class HelpDocumentMissing extends Schema.TaggedError<HelpDocumentMissing>()(
  "CLI.HelpDocumentMissing",
  { command: Schema.String },
) {}

/**
 * Ask Effect CLI to build its structured help model without parsing rendered text.
 *
 * This follows Effect's own annotation tests: the real `--help` path constructs a
 * `HelpDoc`, and an installed formatter captures that value before rendering.
 */
export function helpDocument<Name extends string, Input, ContextInput, E, R>(
  command: Command.Command<Name, Input, ContextInput, E, R>,
  path: readonly string[],
) {
  let captured: HelpDoc.HelpDoc | undefined;
  const formatter: CliOutput.Formatter = {
    ...CliOutput.defaultFormatter({ colors: false }),
    formatHelpDoc: (document) => {
      captured = document;
      return "";
    },
  };
  return Command.runWith(command, { version: "0.0.0", renderErrors: false })([
    ...path,
    "--help",
  ]).pipe(
    Effect.provideService(CliOutput.Formatter, formatter),
    Effect.catchTag("ShowHelp", () => Effect.void),
    Effect.andThen(
      Effect.suspend(() =>
        Effect.fromOption(Option.fromNullishOr(captured)).pipe(
          Effect.mapError(() => new HelpDocumentMissing({ command: path.join(" ") })),
        ),
      ),
    ),
  );
}
