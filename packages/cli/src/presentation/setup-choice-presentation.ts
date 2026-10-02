import { Effect } from "effect";
import { captureSetupAliasApproval } from "../workflows/library/setup-local-custody.js";
import type {
  SetupCopyDecision,
  SetupDuplicateAction,
  SetupSelectedCopy,
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
    action: SetupDuplicateAction,
  ) {
    if (action !== "retire-aliases")
      return { copy, duplicateAction: action } satisfies SetupCopyDecision;
    const approvedAliases = yield* captureSetupAliasApproval(
      copy.sourcePath,
      copy.conflict.kind === "none" ? [] : copy.conflict.shadows,
    );
    return { copy, duplicateAction: action, approvedAliases } satisfies SetupCopyDecision;
  });
  const prompt = Effect.fn("CLI.setup.promptCopies")(function* (
    group: readonly SetupSelectedCopy[],
  ) {
    const first = group[0];
    if (!first || first.conflict.kind === "none") return [];
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
      {
        value: "keep-both",
        label: bulk ? "Keep both copies and enable all" : "Keep both copies and enable",
        hint: "The agent may discover duplicate skills",
      },
      ...(bulk ? [{ value: "individual" as const, label: "Choose individually" }] : []),
    ];
    const action = yield* prompter.select(
      `How should setup handle ${bulk ? `these ${group.length} skills` : first.name}?`,
      choices,
    );
    return action === "individual"
      ? []
      : yield* Effect.forEach(group, (copy) => captureDecision(copy, action));
  });
  const decisions: SetupCopyDecision[] = copies
    .filter((copy) => copy.conflict.kind === "none")
    .map((copy) => ({ copy }));
  const individual: SetupSelectedCopy[] = [];
  for (const kind of ["retirable", "preserve-copies"] as const) {
    const group = copies.filter((copy) => copy.conflict.kind === kind);
    if (group.length < 2) {
      individual.push(...group);
      continue;
    }
    const selected = yield* prompt(group);
    if (selected.length) decisions.push(...selected);
    else individual.push(...group);
  }
  for (const copy of individual.sort((left, right) => left.order - right.order))
    decisions.push(...(yield* prompt([copy])));
  return decisions.sort((left, right) => left.copy.order - right.copy.order);
});

export function setupDuplicatePlanLines(decisions: readonly SetupCopyDecision[]) {
  return (["retain-only", "retire-aliases", "keep-both"] as const).flatMap((action) => {
    const selected = decisions.filter((decision) => decision.duplicateAction === action);
    if (!selected.length) return [];
    const names =
      selected.length <= 5 ? ` · ${selected.map(({ copy }) => copy.name).join(", ")}` : "";
    if (action === "retain-only")
      return [`Retain only: ${skillCount(selected.length)}${names} · no new Binding or Projection`];
    if (action === "keep-both")
      return [`Allow duplicate agent copies: ${skillCount(selected.length)}${names}`];
    const aliases = new Set(
      selected.flatMap((decision) => decision.approvedAliases?.map((alias) => alias.path) ?? []),
    );
    return [
      `Retire redundant symlinks: ${skillCount(selected.length)} · ${aliases.size} symlink${aliases.size === 1 ? "" : "s"}${names} · sources stay; recovery receipts saved`,
    ];
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
