import { Data, Effect, Option } from "effect";
import { CliOutput, Command } from "effect/cli";
import type { HelpDoc } from "effect/cli";
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core";
import { skitCliConfigLayer } from "./parameters.js";

export class HelpDocumentMissing
  extends Data.TaggedError("CLI.HelpDocumentMissing")<{
    command: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Reinstall SKIT; its help documents are missing.";
  get message(): string {
    return `No help document for ${this.command}`;
  }
}

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
    Effect.provide(skitCliConfigLayer),
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
