/**
 * The exact command that applies a recommended plan, for a person or agent to copy. Paths are the
 * resolved absolute roots, never `~`: agent harnesses match commands against allow rules only when
 * every word is literal, and Codex treats a word containing `~` or `$` as possibly expanded.
 */
export function setupApplyCommandLine(input: {
  readonly planId: string;
  readonly repositoryRoots: readonly string[];
  readonly needsDuplicateDecision: boolean;
}): string {
  const quote = (word: string) =>
    /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
  return [
    "skit setup --apply",
    input.planId,
    ...input.repositoryRoots.flatMap((root) => ["--work-dir", quote(root)]),
    ...(input.needsDuplicateDecision ? ["--duplicates", "<import-only|keep-both>"] : []),
  ].join(" ");
}
