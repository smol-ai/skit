import { Console, Effect } from "effect";
import { CliError, CliOutput, Command } from "effect/unstable/cli";
import type { HelpDoc } from "effect/unstable/cli";
import { InvalidArgument } from "../presentation/command-errors.js";
import { renderCommandFailures } from "../application.js";
import { Renderer } from "../presentation/renderer.js";

const quietConsole: Console.Console = Object.assign(Object.create(console), {
  log: () => undefined,
  error: () => undefined,
});

/** Render Effect's structured help model through SKIT's stable output envelope. */
export function formatHelpDocument(document: HelpDoc.HelpDoc): string {
  const formatted = CliOutput.defaultFormatter().formatHelpDoc(document);
  if (!document.subcommands?.length) return formatted;
  const prefix = document.usage.match(/^(.*?)\s+<subcommand>/)?.[1];
  if (!prefix) return formatted;
  return document.subcommands.reduce(
    (text, group) =>
      group.commands.reduce(
        (current, command) =>
          current.replace(
            new RegExp(`^(\\s+)${command.name}(\\s+)`, "m"),
            `$1${prefix} ${command.name}$2`,
          ),
        text,
      ),
    formatted,
  );
}

/** Run the typed grammar while keeping SKIT's help and error presentation boundary. */
export function runCommandTree<Name extends string, Input, ContextInput, E, R>(
  command: Command.Command<Name, Input, ContextInput, E, R>,
  argv: readonly string[],
  version: string,
) {
  let help: HelpDoc.HelpDoc | undefined;
  const formatter: CliOutput.Formatter = {
    ...CliOutput.defaultFormatter({ colors: false }),
    formatHelpDoc: (document) => {
      help = document;
      return "";
    },
  };

  return Effect.gen(function* () {
    const renderer = yield* Renderer;
    yield* Command.runWith(command, { version, renderErrors: false })(argv).pipe(
      Effect.provideService(CliOutput.Formatter, formatter),
      Effect.provideService(Console.Console, quietConsole),
      Effect.catchIf(
        (error): error is CliError.ShowHelp =>
          CliError.isCliError(error) && error._tag === "ShowHelp",
        (request) =>
          request.errors.length
            ? Effect.fail(
                new InvalidArgument({
                  message: request.errors.map((error) => error.message).join("\n"),
                }),
              )
            : Effect.void,
      ),
    );
    if (help) yield* renderer.help(formatHelpDocument(help));
  }).pipe(renderCommandFailures);
}
