import { FailureTypeId, type SkitFailure } from "@smolai/skit-core/shared";
import { SkitConfiguration, resolveSkitConfiguration } from "@smolai/skit-core/platform";
import { Cause, Data, Effect, Option } from "effect";
import {
  CliConfig,
  CliError,
  CliOutput,
  Command,
  Completions,
  GlobalFlag,
  type HelpDoc,
} from "effect/cli";
import { skitCliConfigLayer } from "./parameters.js";

import { commandFailure } from "./failure-classification.js";
import { Renderer } from "../terminal/renderer.js";
import { result } from "./result.js";

/** The command line did not parse; the parser's own sentences are the message. */
class CommandLineInvalid
  extends Data.TaggedError("CommandLineInvalid")<{ message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation = "Run `skit --help` to review command usage.";
}

/** Render Effect's structured help model through SKIT's stable output envelope. */
function formatHelpDocument(document: HelpDoc.HelpDoc): string {
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
  return Effect.uninterruptibleMask((restore) =>
    restore(
      Effect.scoped(
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          // Defer implicit help until parsing succeeds: invalid input uses SKIT's failure envelope.
          let output: CliOutput.Presenter.Event | undefined;
          const presenter: CliOutput.Presenter = {
            present: (event) =>
              Effect.sync(() => {
                output = event;
              }),
          };
          // Completions still bypass Presenter in Effect. Reuse its flag and generator,
          // with the same Renderer boundary as every other successful CLI result.
          const cliConfig = yield* CliConfig.CliConfig.pipe(Effect.provide(skitCliConfigLayer));
          const completions = GlobalFlag.Action({
            flag: GlobalFlag.Completions.flag,
            run: (shell, context) =>
              Option.isNone(shell)
                ? Effect.void
                : renderer.result(
                    result("completions", {
                      shell: shell.value,
                      script: Completions.generate(
                        context.command.name,
                        shell.value,
                        Completions.fromCommand(context.command),
                      ),
                    }),
                  ),
          });
          // Standalone command runners share the same configuration boundary as main.
          // Keep an already resolved application snapshot when one was supplied.
          const supplied = yield* Effect.serviceOption(SkitConfiguration);
          const configuration = Option.isSome(supplied)
            ? supplied.value
            : yield* resolveSkitConfiguration();
          yield* Command.runWith(command, { version, renderErrors: false })(argv).pipe(
            Effect.provideService(SkitConfiguration, configuration),
            Effect.provideService(CliOutput.Presenter, presenter),
            Effect.provideService(CliConfig.CliConfig, {
              ...cliConfig,
              builtIns: cliConfig.builtIns.map((flag) =>
                flag === GlobalFlag.Completions ? completions : flag,
              ),
            }),
            Effect.catchIf(
              (error): error is CliError.ShowHelp =>
                CliError.isCliError(error) && error._tag === "ShowHelp",
              (request) =>
                request.errors.length
                  ? Effect.fail(
                      new CommandLineInvalid({
                        message: request.errors.map((error) => error.message).join("\n"),
                      }),
                    )
                  : Effect.void,
            ),
          );
          if (output?._tag === "Help") yield* renderer.help(formatHelpDocument(output.helpDoc));
          if (output?._tag === "Version")
            yield* renderer.result(result("version", { version: output.version }));
        }),
      ),
    ).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.flatMap(Renderer, (renderer) => renderer.failure(commandFailure(cause))),
      ),
    ),
  );
}
