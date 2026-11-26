import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { bannedForm, bannedVerbs } from "../../../../lint/term-rules.mjs";
import type { CopyIssue } from "./data.ts";

const verbs = bannedVerbs(readFileSync(new URL("../../../../CONTEXT.md", import.meta.url), "utf8"));

const patterns: ReadonlyArray<{ readonly kind: CopyIssue["kind"]; readonly pattern: RegExp }> = [
  // TypeIDs such as skill_01m71f65zafev84e08s26cng5a.
  { kind: "ID", pattern: /\b[a-z][a-z0-9]*_[0-9a-z]{26}\b/g },
  { kind: "hash", pattern: /\bsha256:[0-9a-f]{20,}|\b[0-9a-f]{40,}\b/g },
  { kind: "code", pattern: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g },
];

// Approved policy: exact arguments required by runnable commands are not prose copy issues.
// Match only the positions verified against SKIT's command definitions and Wrangler cleanup.
// Quoting the same value elsewhere, or merely mentioning a flag, grants no allowance.
const word = (text: string) => `(?:${text}|"${text}"|'${text}')`;
const words = (...parts: string[]) => parts.map(word).join("\\s+");
const operation = "op_[0-9a-z]{26}";
// The recovery owner also accepts historical operation directory names (moves.ts).
const recoveryOperation = "[A-Za-z0-9_-]+";
const subject = "(?:coll|skill)_[0-9a-z]{26}";
const hash = "sha256:[0-9a-f]{64}";
const requiredArguments = [
  { before: words("skit", "update"), argument: subject },
  { before: words("skit", "library", "undo"), argument: operation },
  { before: words("skit", "library", "recovery", "(?:inspect|restore)"), argument: operation },
  { before: words("skit", "setup", "--apply"), argument: hash },
  { before: words("skit", "setup", "--apply", hash, "--reviewed"), argument: hash },
  { before: words("skit", "library", "undo", recoveryOperation, "--apply"), argument: hash },
  {
    before: words("skit", "library", "recovery", "restore", recoveryOperation, "--apply"),
    argument: hash,
  },
  {
    before: words("skit", "sync", "--apply", "--take-remote"),
    argument: "(?:collection:coll_|skill:skill_)[0-9a-z]{26}",
  },
  { before: words("skit", "sync", "--apply", "--keep-enabled"), argument: "skill_[0-9a-z]{26}" },
  { before: words("wrangler", "secret", "delete"), argument: "SKIT_BOOTSTRAP_SECRET" },
].map(
  ({ before, argument }) =>
    new RegExp(
      `(?<![A-Za-z0-9_-])${before}\\s+(?<quote>["']?)(?<argument>${argument})\\k<quote>(?=$|\\s|[.,;](?=\\s|$))`,
      "g",
    ),
);

const commandArgumentSpans = (text: string) =>
  requiredArguments.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => {
      const argument = match.groups!.argument!;
      const start = match.index + match[0].lastIndexOf(argument);
      return { start, end: start + argument.length };
    }),
  );

/** Every distinct issue in plain text, in order of appearance. */
export function copyIssues(text: string): readonly CopyIssue[] {
  const allowed = commandArgumentSpans(text);
  const found: Array<CopyIssue & { readonly at: number }> = [
    ...patterns.flatMap(({ kind, pattern }) =>
      [...text.matchAll(pattern)].map((match) => ({ kind, text: match[0], at: match.index })),
    ),
    ...[...text.matchAll(/[A-Za-z]+/g)].flatMap((match) => {
      const verb = bannedForm(match[0], verbs);
      return verb === undefined
        ? []
        : [{ kind: "term" as const, text: match[0], at: match.index, verb }];
    }),
  ].sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  return found.flatMap((issue) => {
    if (
      issue.kind !== "term" &&
      allowed.some(({ start, end }) => start <= issue.at && issue.at + issue.text.length <= end)
    )
      return [];
    if (seen.has(issue.text)) return [];
    seen.add(issue.text);
    return [
      {
        kind: issue.kind,
        text: issue.text,
        ...(issue.verb === undefined ? {} : { verb: issue.verb }),
      },
    ];
  });
}

/**
 * Overlines each issue in terminal text, leaving its colours as they are. The CLI never draws an
 * overline, so laying out the marked text shows which cells each issue covers.
 */
export function markIssues(ansi: string, issues: readonly CopyIssue[]): string {
  const plain = stripVTControlCharacters(ansi);
  const allowed = commandArgumentSpans(plain);
  return issues.reduce(
    (marked, { text, kind }) =>
      marked.replace(
        new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
        (match, offset: number) => {
          const at = stripVTControlCharacters(marked.slice(0, offset)).length;
          if (
            /[A-Za-z0-9_]/.test(plain[at - 1] ?? "") ||
            /[A-Za-z0-9_]/.test(plain[at + match.length] ?? "")
          )
            return match;
          return kind !== "term" &&
            allowed.some(({ start, end }) => start <= at && at + match.length <= end)
            ? match
            : `\u001b[53m${match}\u001b[55m`;
        },
      ),
    ansi,
  );
}
