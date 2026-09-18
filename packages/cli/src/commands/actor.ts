import type { Command } from "effect/unstable/cli";

/**
 * The command a person invoked, as the Library's history names it: the longest run of leading
 * arguments that are subcommands of the real tree, so a subject or a flag is never part of it.
 */
export const commandActor = (root: Command.Command.Any, argv: readonly string[]): string => {
  const path: string[] = [];
  let current = root;
  for (const token of argv) {
    const next = current.subcommands
      .flatMap((group) => group.commands)
      .find((command) => command.name === token);
    if (next === undefined) break;
    path.push(next.name);
    current = next;
  }
  return path.length === 0 ? root.name : path.join(" ");
};
