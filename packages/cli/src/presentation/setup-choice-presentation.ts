import { Effect } from "effect";
import { captureLocalAdoptionAliases } from "../workflows/library/local-adoption.js";
import type { SetupReviewSummary } from "../workflows/library/setup-review.js";
import {
  type SetupCopyDecision,
  type SetupDuplicateAction,
  type SetupSelectedCopy,
} from "../workflows/library/setup-decisions.js";
import { Prompter, type Choice } from "./prompter.js";
import { Renderer } from "./renderer.js";

const skillCount = (count: number) => `${count} skill${count === 1 ? "" : "s"}`;

/** Group and singleton decisions share evidence, eligibility and prompt construction. */
export const chooseSetupCopyDecisions = Effect.fn("CLI.setup.chooseCopyDecisions")(function* (
  copies: readonly SetupSelectedCopy[],
  displayPath: (path: string) => string,
) {
  const prompter = yield* Prompter;
  const renderer = yield* Renderer;
  const captureDecision = Effect.fn("CLI.setup.captureDecision")(function* (
    copy: SetupSelectedCopy,
    action: SetupDuplicateAction | undefined,
  ): Effect.fn.Return<
    SetupCopyDecision,
    Effect.Error<ReturnType<typeof captureLocalAdoptionAliases>>,
    Effect.Services<ReturnType<typeof captureLocalAdoptionAliases>>
  > {
    if (action === undefined) return copy;
    if (action !== "retire-aliases") return { ...copy, duplicateAction: action };
    const approvedAliases = yield* captureLocalAdoptionAliases(
      copy.sourcePath,
      copy.conflict.kind === "none" ? [] : copy.conflict.shadows,
    );
    return { ...copy, duplicateAction: action, approvedAliases };
  });
  const actions = new Map<SetupSelectedCopy, SetupDuplicateAction>();
  const prompt = Effect.fn("CLI.setup.promptCopies")(function* (
    group: readonly SetupSelectedCopy[],
  ) {
    const first = group[0];
    if (!first || first.conflict.kind === "none") return;
    const bulk = group.length > 1;
    const retirable = first.conflict.kind === "retirable";
    const aliases = new Set(
      group.flatMap((copy) => (copy.conflict.kind === "none" ? [] : copy.conflict.aliases)),
    );
    const examples = [
      ...new Set(
        group.flatMap((copy) =>
          copy.conflict.kind === "none"
            ? []
            : copy.conflict.shadows.flatMap((shadow) =>
                shadow.aliases.map(
                  (alias) =>
                    `${displayPath(alias.path)}${alias.via === "symlink" ? ` → ${displayPath(shadow.canonicalPath)} (symlink${alias.linkPath && alias.linkPath !== alias.path ? ` at ${displayPath(alias.linkPath)}` : ""})` : " (directory)"}`,
                ),
              ),
        ),
      ),
    ];
    yield* renderer.note(
      [
        ...(bulk && !retirable
          ? [
              "These locations are not all individual symlinks to the selected source. Retain without enabling to avoid another agent copy.",
            ]
          : []),
        ...(bulk ? examples.slice(0, 5) : examples),
        ...(bulk && examples.length > 5 ? [`… and ${examples.length - 5} more locations`] : []),
      ].join("\n"),
      `${bulk ? `${group.length} skills` : first.name}: enabling would create another agent copy`,
    );
    const choices: Choice<SetupDuplicateAction | "individual">[] = [
      ...(retirable
        ? [
            {
              value: "retire-aliases" as const,
              label: bulk
                ? `Retire redundant symlinks for all ${group.length} skills (${aliases.size} symlinks)`
                : "Manage with SKIT and retire redundant symlinks",
              hint: bulk
                ? "Source directories stay; recovery receipts saved"
                : "Source stays in place; links saved with a recovery receipt",
            },
          ]
        : []),
      {
        value: "retain-only",
        label: bulk
          ? "Retain all in Library without enabling"
          : "Retain in Library without enabling",
      },
      // A link where SKIT writes its copy is replaced, so both copies cannot stay.
      ...(group.some((copy) => copy.conflict.kind !== "none" && copy.conflict.replacesLink)
        ? []
        : [
            {
              value: "keep-both" as const,
              label: bulk ? "Keep both copies and enable all" : "Keep both copies and enable",
              hint: "The agent may discover duplicate skills",
            },
          ]),
      ...(bulk ? [{ value: "individual" as const, label: "Choose individually" }] : []),
    ];
    const action = yield* prompter.select(
      `How should setup handle ${bulk ? `these ${group.length} skills` : first.name}?`,
      choices,
    );
    if (action !== "individual") for (const copy of group) actions.set(copy, action);
  });
  for (const kind of ["retirable", "preserve-copies"] as const) {
    const group = copies.filter((copy) => copy.conflict.kind === kind);
    if (group.length > 1) yield* prompt(group);
  }
  for (const copy of copies)
    if (copy.conflict.kind !== "none" && !actions.has(copy)) yield* prompt([copy]);
  return yield* Effect.forEach(copies, (copy) => captureDecision(copy, actions.get(copy)));
});

/** The changes guided setup asks the user to approve, one line per effect. */
export function setupPlanLines(input: {
  readonly summary: SetupReviewSummary;
  readonly displayRoots: string;
  readonly displayPath: (path: string) => string;
}) {
  const { summary, displayPath } = input;
  return [
    ...(summary.persistRoots ? [`Save discovery roots: ${input.displayRoots}`] : []),
    ...summary.repositoryDecisions.map(
      (decision) =>
        `${decision.status === "watched" ? "Watch" : "Ignore"} repository: ${displayPath(decision.path)}`,
    ),
    ...(summary.createsMachineIdentity ? ["Create this machine's stable Library identity"] : []),
    ...(summary.sources.length
      ? [
          `Import installed skills.sh Collections into the SKIT Library: ${summary.sources.length}`,
          ...summary.sources.flatMap(({ source, lockContentHash, names }) => [
            `  ${source} · observed lock ${lockContentHash.slice(0, 14)} · ${names.length} skill${names.length === 1 ? "" : "s"}`,
            ...(names.length <= 5 ? [`    ${names.join(", ")}`] : []),
          ]),
        ]
      : []),
    ...(summary.reconnects.length
      ? [
          `Reconnect existing Library matches: ${summary.reconnects.length}`,
          ...summary.reconnects
            .slice(0, 5)
            .map(({ name, sourcePath }) => `  ${name} · ${displayPath(sourcePath)}`),
          ...(summary.reconnects.length > 5
            ? [`  … and ${summary.reconnects.length - 5} more`]
            : []),
        ]
      : []),
    ...(summary.additions.length
      ? [
          `Add to Library: ${summary.additions.length}`,
          ...summary.additions
            .slice(0, 5)
            .map((selection) => `  ${selection.name} · ${displayPath(selection.sourcePath)}`),
          ...(summary.additions.length > 5 ? [`  … and ${summary.additions.length - 5} more`] : []),
        ]
      : []),
    ...setupDuplicatePlanLines(summary.duplicates),
    ...(summary.custodyCount ? [`Take custody: ${summary.custodyCount}`] : []),
    ...summary.authoritativeCopies.flatMap((selection) => [
      `Authoritative copy: ${selection.name} · ${selection.sourcePath}`,
      "  Other copies stay in place unless explicitly marked Remove.",
    ]),
    ...(summary.removals.entries.length
      ? [
          `Remove installed copies: ${summary.removals.entries.length}`,
          ...summary.removals.entries.map(
            (entry) =>
              `  ${entry.name} · ${entry.path}${entry.type === "SymbolicLink" ? " (symlink only; source stays)" : " (move directory to recovery)"}`,
          ),
          `Recovery folder: ${summary.removals.recoveryDirectory}`,
          "Library entries and source files outside these locations stay in place.",
        ]
      : []),
    ...(summary.repositoryCopiesRemain
      ? [
          "Repository copies stay in place. To transfer custody later, remove the repository copy and run `skit enable`.",
        ]
      : []),
  ];
}

function setupDuplicatePlanLines(duplicates: SetupReviewSummary["duplicates"]) {
  return duplicates.map(({ action, names, aliasCount }) => {
    const examples = names.length <= 5 ? ` · ${names.join(", ")}` : "";
    if (action === "retain-only")
      return `Retain only: ${skillCount(names.length)}${examples} · no new Binding or Projection`;
    if (action === "keep-both")
      return `Allow duplicate agent copies: ${skillCount(names.length)}${examples}`;
    return `Retire redundant symlinks: ${skillCount(names.length)} · ${aliasCount} symlink${aliasCount === 1 ? "" : "s"}${examples} · sources stay; recovery receipts saved`;
  });
}

export const renderSetupAliasRecovery = Effect.fn("CLI.setup.renderAliasRecovery")(
  function* (applied: {
    readonly warnings: readonly { readonly name: string; readonly message: string }[];
    readonly recoveryDirectories: readonly string[];
  }) {
    const renderer = yield* Renderer;
    for (const warning of applied.warnings)
      yield* renderer.note(warning.message, `${warning.name}: alias preserved`);
    if (applied.recoveryDirectories.length)
      yield* renderer.note(
        `Sources stay in place. Symlinks and restoration receipts are saved in:\n${applied.recoveryDirectories.join("\n")}`,
        `Redundant symlinks retired for ${skillCount(applied.recoveryDirectories.length)}${applied.warnings.length ? ` · ${skillCount(applied.warnings.length)} preserved` : ""}`,
      );
  },
);
