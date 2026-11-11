import type { SetupWarning } from "@smolai/skit-core/library/setup";
import { setupWarning } from "./warnings.js";
import { Effect } from "effect";
import {
  type SetupReviewSummary,
  setupDuplicateActions,
  setupDuplicateChoiceRequired,
  type SetupCopyChoice,
  type SetupDuplicateAction,
  type SetupSelectedCopy,
} from "@smolai/skit-core/library/setup";

import { Prompter, type Choice } from "../../terminal/prompter.js";
import { Renderer } from "../../terminal/renderer.js";
import { Block } from "../../terminal/blocks.js";

const skillCount = (count: number) => `${count} skill${count === 1 ? "" : "s"}`;

/** Group and singleton decisions share evidence, eligibility and prompt construction. */
export const chooseSetupCopyDecisions = Effect.fn("CLI.setup.chooseCopyDecisions")(function* (
  copies: readonly SetupSelectedCopy[],
) {
  const prompter = yield* Prompter;
  const renderer = yield* Renderer;
  const actions = new Map<SetupSelectedCopy, SetupDuplicateAction>();
  const prompt = Effect.fn("CLI.setup.promptCopies")(function* (
    group: readonly SetupSelectedCopy[],
  ) {
    const first = group[0];
    if (!first || first.conflict.kind === "none") return;
    const bulk = group.length > 1;
    const alternatives = setupDuplicateActions(group);
    const examples = [
      ...new Set(
        group.flatMap((copy) =>
          copy.conflict.kind === "none"
            ? []
            : copy.conflict.duplicates.flatMap((duplicate) =>
                duplicate.aliases.map(
                  (alias) =>
                    `${alias.path}${alias.via === "symlink" ? ` → ${duplicate.canonicalPath} (symlink${alias.linkPath && alias.linkPath !== alias.path ? ` at ${alias.linkPath}` : ""})` : " (directory)"}`,
                ),
              ),
        ),
      ),
    ];
    yield* renderer.note(
      [
        ...(bulk
          ? [
              Block.Note({
                text: [
                  "These locations are not all individual symlinks to the selected source. Add without enabling to avoid another agent copy.",
                ],
              }),
            ]
          : []),
        Block.List({
          items: [
            ...(bulk ? examples.slice(0, 5) : examples).map((example) => ({
              text: [{ dim: example }],
            })),
            ...(bulk && examples.length > 5
              ? [{ text: [`… and ${examples.length - 5} more locations`] }]
              : []),
          ],
        }),
      ],
      `${bulk ? `${group.length} skills` : first.name}: enabling would create another agent copy`,
    );
    const choices: Choice<SetupDuplicateAction | "individual">[] = [
      {
        value: "retain-only",
        label: bulk
          ? "Add all to the Library without enabling"
          : "Add to the Library without enabling",
      },
      // A link where SKIT writes its copy is replaced, so both copies cannot stay.
      ...(!alternatives.includes("keep-both")
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
  const unresolved = copies.filter(setupDuplicateChoiceRequired);
  if (unresolved.length > 1) yield* prompt(unresolved);
  for (const copy of unresolved) if (!actions.has(copy)) yield* prompt([copy]);
  return copies.map((copy): SetupCopyChoice => ({
    ...copy,
    ...(actions.has(copy) ? { duplicateAction: actions.get(copy)! } : {}),
  }));
});

/** The changes guided setup asks the user to approve. */
export function setupPlan(input: {
  readonly summary: SetupReviewSummary;
  readonly displayRoots: string;
}): Block[] {
  const { summary } = input;
  const table = (titles: readonly string[], rows: ReadonlyArray<readonly string[]>) =>
    Block.Table({
      columns: titles.map((title) => ({ title })),
      rows: rows.map((row) => row.map((cell) => [cell])),
    });
  // Long selections show their first five, then how many more.
  const firstFive = <T>(items: readonly T[], row: (item: T) => readonly string[]) => [
    table(["Skill", "Path"], items.slice(0, 5).map(row)),
    ...(items.length > 5
      ? [Block.Note({ text: [{ dim: `… and ${items.length - 5} more` }] })]
      : []),
  ];
  const facts = [
    ...(summary.persistRoots
      ? [{ label: "Save discovery roots", value: [input.displayRoots] }]
      : []),
    ...summary.repositoryDecisions.map((decision) => ({
      label: decision.status === "watched" ? "Watch repository" : "Ignore repository",
      value: [decision.path],
    })),
    ...(summary.manageCount
      ? [{ label: "Manage existing", value: [`${summary.manageCount}`] }]
      : []),
  ];
  return [
    ...(summary.sourceUpdateMayNeedReview
      ? [
          Block.Status({
            tone: "warn",
            text: [
              "Setup leaves existing managed copies unchanged. Use skit update to handle their edits or newer Library versions.",
            ],
          }),
        ]
      : []),
    ...(summary.createsMachineIdentity
      ? [Block.Note({ text: ["Create this machine's stable Library identity."] })]
      : []),
    ...(facts.length ? [Block.Fields({ rows: facts })] : []),
    ...(summary.sources.length
      ? [
          Block.Group({
            title: `Import installed skills.sh Collections into the SKIT Library (${summary.sources.length})`,
            children: [
              table(
                ["Collection", "Lock", "Skills"],
                summary.sources.map(({ source, lockContentHash, names }) => [
                  source,
                  lockContentHash.slice(0, 14),
                  names.length <= 5 ? names.join(", ") : skillCount(names.length),
                ]),
              ),
            ],
          }),
        ]
      : []),
    ...(summary.reconnects.length
      ? [
          Block.Group({
            title: `Reconnect existing Library matches (${summary.reconnects.length})`,
            children: firstFive(summary.reconnects, ({ name, sourcePath }) => [name, sourcePath]),
          }),
        ]
      : []),
    ...(summary.additions.length
      ? [
          Block.Group({
            title: `Add to Library (${summary.additions.length})`,
            children: firstFive(summary.additions, ({ name, sourcePath }) => [name, sourcePath]),
          }),
        ]
      : []),
    ...(summary.duplicates.length
      ? [
          Block.Group({
            title: "Other copies",
            children: [Block.Fields({ rows: summary.duplicates.map(duplicatePlan) })],
          }),
        ]
      : []),
    ...(summary.authoritativeCopies.length
      ? [
          Block.Group({
            title: "Authoritative copies",
            children: [
              table(
                ["Skill", "Path"],
                summary.authoritativeCopies.map(({ name, sourcePath }) => [name, sourcePath]),
              ),
              Block.Note({ text: ["Other copies stay in place unless explicitly marked Remove."] }),
            ],
          }),
        ]
      : []),
    ...(summary.removals.entries.length
      ? [
          Block.Group({
            title: `Remove installed copies (${summary.removals.entries.length})`,
            children: [
              table(
                ["Skill", "Path", "Effect"],
                summary.removals.entries.map((entry) => [
                  entry.name,
                  entry.path,
                  entry.type === "SymbolicLink"
                    ? "symlink only; source stays"
                    : "move directory to recovery",
                ]),
              ),
              Block.Note({
                text: [
                  "Removed copies are moved into the Library's removed/ folder, under this setup's operation ID. Library entries and source files outside these locations stay in place.",
                ],
              }),
            ],
          }),
        ]
      : []),
    ...(summary.repositoryCopiesRemain
      ? [
          Block.Note({
            text: [
              "Repository copies stay in place. To have SKIT manage it later, remove the repository copy and run ",
              { code: "skit enable" },
              ".",
            ],
          }),
        ]
      : []),
  ];
}

/** What setup does with other copies of the selected skills, as one labelled fact. */
function duplicatePlan({ action, names, aliasCount }: SetupReviewSummary["duplicates"][number]) {
  const examples = names.length <= 5 ? ` (${names.join(", ")})` : "";
  if (action === "retain-only")
    return {
      label: "Add only",
      value: [`${skillCount(names.length)}${examples}. Nothing new is enabled or installed.`],
    };
  if (action === "keep-both")
    return {
      label: "Allow duplicate agent copies",
      value: [`${skillCount(names.length)}${examples}`],
    };
  if (action === "preserve-duplicates")
    return {
      label: "Back up existing copies",
      value: [
        `${aliasCount} director${aliasCount === 1 ? "y" : "ies"}${examples}. Replacements are verified before the originals move to recovery.`,
      ],
    };
  return {
    label: "Back up redundant symlinks",
    value: [
      `${skillCount(names.length)}, ${aliasCount} symlink${aliasCount === 1 ? "" : "s"}${examples}. Sources stay; move records are saved.`,
    ],
  };
}

export const renderSetupAliasRecovery = Effect.fn("CLI.setup.renderAliasRecovery")(
  function* (applied: {
    readonly warnings: readonly SetupWarning[];
    readonly recoveryDirectories: readonly string[];
  }) {
    const renderer = yield* Renderer;
    for (const warning of applied.warnings)
      yield* renderer.note(
        [Block.Status({ tone: "warn", text: [setupWarning(warning)] })],
        `${warning.name}: existing copy kept`,
      );
    if (applied.recoveryDirectories.length)
      yield* renderer.note(
        [
          Block.Note({
            text: ["Sources stay in place. Symlinks and their move records are saved in:"],
          }),
          Block.List({
            items: applied.recoveryDirectories.map((directory) => ({ text: [{ dim: directory }] })),
          }),
        ],
        `Redundant symlinks removed for ${skillCount(applied.recoveryDirectories.length)}${applied.warnings.length ? ` | ${skillCount(applied.warnings.length)} preserved` : ""}`,
      );
  },
);
