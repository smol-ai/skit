import { Effect, Option } from "effect";
import { CliOutput, Command } from "effect/cli";
import type { HelpDoc } from "effect/cli";
import { HelpDocumentMissing } from "./help-failures.js";
import { skitCliConfigLayer } from "./parameters.js";

/**
 * Ask Effect CLI to build its structured help model without parsing rendered text.
 *
 * The real `--help` path supplies the structured document to Presenter without rendering it.
 */
export function helpDocument<Name extends string, Input, ContextInput, E, R>(
  command: Command.Command<Name, Input, ContextInput, E, R>,
  path: readonly string[],
) {
  return Effect.gen(function* () {
    let captured: HelpDoc.HelpDoc | undefined;
    const presenter: CliOutput.Presenter = {
      present: (event) =>
        Effect.sync(() => {
          if (event._tag === "Help") captured = event.helpDoc;
        }),
    };
    yield* Command.runWith(command, { version: "0.0.0", renderErrors: false })([
      ...path,
      "--help",
    ]).pipe(
      Effect.provideService(CliOutput.Presenter, presenter),
      Effect.provide(skitCliConfigLayer),
      Effect.catchTag("ShowHelp", () => Effect.void),
    );
    return yield* Effect.fromOption(Option.fromNullishOr(captured)).pipe(
      Effect.mapError(() => new HelpDocumentMissing({ command: path.join(" ") })),
    );
  });
}
