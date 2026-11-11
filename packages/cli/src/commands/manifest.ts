import { errorOutputContract } from "./error-output.js";
import { Context, Effect, Option } from "effect";
import * as Command from "effect/cli/Command";
import { helpDocument } from "./help-document.js";
import { commandInvocation, type CommandInvocation } from "./invocation.js";
import { CommandMetadata } from "./metadata.js";
import type { CommandDescription } from "./command-contracts.js";

interface CommandDocument extends CommandDescription {
  readonly invocation: CommandInvocation;
  readonly examples: readonly string[];
  readonly positionals: readonly {
    readonly name: string;
    readonly required: boolean;
  }[];
  readonly documentedFlags: Readonly<
    Record<
      string,
      {
        readonly type: string;
        readonly valueName: string;
        readonly description: string;
      }
    >
  >;
}

interface TraversableCommand {
  readonly name: string;
  readonly annotations: Context.Context<never>;
  readonly subcommands: ReadonlyArray<{
    readonly commands: readonly TraversableCommand[];
  }>;
}

function leaves(
  command: TraversableCommand,
  parent: readonly string[] = [],
  ancestors: readonly TraversableCommand[] = [],
): ReadonlyArray<{
  readonly path: readonly string[];
  readonly ancestors: readonly TraversableCommand[];
}> {
  const path = command.name === "skit" ? parent : [...parent, command.name];
  const children = command.subcommands.flatMap((group) => group.commands);
  const lineage = [...ancestors, command];
  return children.length === 0
    ? [{ path, ancestors: lineage }]
    : children.flatMap((child) => leaves(child, path, lineage));
}

/** Derive the public command manifest from the executable Effect command tree. */
export function commandDocuments<Name extends string, Input, ContextInput, E, R>(
  root: Command.Command<Name, Input, ContextInput, E, R>,
) {
  return Effect.forEach(leaves(root), ({ path, ancestors }) =>
    Effect.gen(function* () {
      const document = yield* helpDocument(root, path);
      const metadata = Context.get(document.annotations, CommandMetadata);
      const allFlags = [
        ...document.flags,
        ...(document.inheritedFlags ?? []),
        ...(document.globalFlags ?? []),
      ];
      return {
        path,
        invocation: commandInvocation(document, ancestors, metadata.handlerRules),
        summary: document.description,
        stability: metadata.stability ?? "stable",
        effects: metadata.effects ?? { capabilities: [] },
        outputSchemas: [
          ...metadata.outputSchemas.map((contract) => contract.id),
          "skit.help.v1",
          errorOutputContract.id,
        ],
        interactive: metadata.interactive,
        flags: Object.fromEntries(allFlags.map((flag) => [flag.name, { type: flag.type }])),
        examples: (document.examples ?? []).map((example) => example.command),
        positionals: (document.args ?? []).map((argument) => ({
          name: argument.name,
          required: argument.required,
        })),
        documentedFlags: Object.fromEntries(
          allFlags.map((flag) => [
            flag.name,
            {
              type: flag.type,
              valueName: flag.type,
              description: Option.getOrElse(flag.description, () => ""),
            },
          ]),
        ),
      } satisfies CommandDocument;
    }),
  );
}

/** The machine-readable subset used by generated command contracts and internal checks. */
export function commandDescriptions<Name extends string, Input, ContextInput, E, R>(
  root: Command.Command<Name, Input, ContextInput, E, R>,
) {
  return commandDocuments(root).pipe(
    Effect.map((documents) =>
      documents.map(
        ({
          invocation: _invocation,
          documentedFlags: _documentedFlags,
          examples: _examples,
          positionals: _positionals,
          ...description
        }) => description,
      ),
    ),
  );
}
