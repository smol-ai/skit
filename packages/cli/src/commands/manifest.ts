import { Context, Effect, Option } from "effect";
import * as Command from "effect/unstable/cli/Command";
import { helpDocument } from "./help-document.js";
import { CommandMetadata } from "./metadata.js";
import type { CommandDescription } from "./command-contracts.js";

export type { CommandDescription } from "./command-contracts.js";

export interface CommandDocument extends CommandDescription {
  readonly examples: readonly string[];
  readonly positionals: readonly { readonly name: string; readonly required: boolean }[];
  readonly documentedFlags: Readonly<
    Record<
      string,
      { readonly type: string; readonly valueName: string; readonly description: string }
    >
  >;
}

interface TraversableCommand {
  readonly name: string;
  readonly subcommands: ReadonlyArray<{
    readonly commands: readonly TraversableCommand[];
  }>;
}

const sharedErrorExitCodes = [1, 11, 12, 64, 65, 77] as const;

function leaves(
  command: TraversableCommand,
  parent: readonly string[] = [],
): ReadonlyArray<{ readonly path: readonly string[] }> {
  const path = command.name === "skit" ? parent : [...parent, command.name];
  const children = command.subcommands.flatMap((group) => group.commands);
  return children.length === 0 ? [{ path }] : children.flatMap((child) => leaves(child, path));
}

/** Derive the public command manifest from the executable Effect command tree. */
export function commandDocuments<Name extends string, Input, ContextInput, E, R>(
  root: Command.Command<Name, Input, ContextInput, E, R>,
) {
  return Effect.forEach(leaves(root), ({ path }) =>
    Effect.gen(function* () {
      const document = yield* helpDocument(root, path);
      const metadata = Context.get(document.annotations, CommandMetadata);
      const allFlags = [...document.flags, ...(document.globalFlags ?? [])];
      return {
        path,
        summary: document.description,
        stability: metadata.stability ?? "stable",
        effects: metadata.effects ?? { capabilities: [] },
        outputSchemas: [
          ...metadata.outputSchemas.map((contract) => contract.id),
          "skit.help.v1",
          "skit.error.v1",
        ],
        successExitCodes: metadata.exitCodes,
        errorExitCodes: [...sharedErrorExitCodes],
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
          documentedFlags: _documentedFlags,
          examples: _examples,
          positionals: _positionals,
          ...description
        }) => description,
      ),
    ),
  );
}
