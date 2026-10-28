import { basename, dirname, resolve } from "node:path";
import { Schema } from "effect";
import { Digest, SkillId } from "@smolai/skit-core";
import {
  SetupApplied,
  SetupResult,
  InstalledSkillChange,
  SetupVersionChoice,
} from "../workflows/library/setup-contract.js";
import {
  SetupDuplicateAction,
  type SetupExplicitSelection,
} from "../workflows/library/setup-decisions.js";
import type { SetupReview, SetupReviewSummary } from "../workflows/library/setup-review.js";
import type { InventoryRootOptions } from "../install/roots.js";
import { CommandAction } from "./command-actions.js";

const Choice = Schema.Struct({
  kind: Schema.Literals(["copy", "source", "removal", "existing", "version"]),
  label: Schema.String,
  path: Schema.optionalKey(Schema.String),
  sourceId: Schema.optionalKey(Digest),
  skillId: Schema.optionalKey(SkillId),
  duplicateActions: Schema.Array(SetupDuplicateAction),
  actions: Schema.Array(CommandAction),
});
export const SetupOutput = Schema.Struct({
  ...SetupResult.fields,
  actions: Schema.Array(CommandAction),
  choices: Schema.Array(Choice),
});
export const SetupAppliedOutput = Schema.Struct({
  ...SetupApplied.fields,
  actions: Schema.Array(CommandAction),
});
export const SetupReviewOutput = Schema.Struct({
  planId: Digest,
  reviewId: Digest,
  hasChanges: Schema.Boolean,
  canApply: Schema.Boolean,
  summary: Schema.Struct({
    sourceUpdateMayNeedReview: Schema.Boolean,
    changes: Schema.Array(InstalledSkillChange),
    versionChoices: Schema.Array(SetupVersionChoice),
    savesMachineSettings: Schema.Boolean,
    createsMachineIdentity: Schema.Boolean,
    sources: Schema.Array(
      Schema.Struct({ source: Schema.String, names: Schema.Array(Schema.String) }),
    ),
    enables: Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String })),
    retains: Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String })),
    preserves: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        path: Schema.String,
        kind: Schema.Literals(["symlink", "directory"]),
      }),
    ),
    removals: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        path: Schema.String,
        type: Schema.Literals(["Directory", "SymbolicLink"]),
      }),
    ),
  }),
  actions: Schema.Array(CommandAction),
});
export const SetupComparisonOutput = Schema.Struct({
  planId: Digest,
  copies: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      path: Schema.String,
      observedHash: Digest,
      markdown: Schema.String,
      truncated: Schema.Boolean,
    }),
  ),
  actions: Schema.Array(CommandAction),
});
export const SetupFailureOutput = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  remediation: Schema.String,
  actions: Schema.Array(CommandAction),
});

export interface SetupActionContext {
  readonly home: string;
  readonly inventory: InventoryRootOptions;
  readonly workDir?: string;
}
export interface SetupCommandSelection {
  readonly selection?: SetupExplicitSelection;
  readonly duplicates?: SetupDuplicateAction;
}

/** The CLI alone owns routing facts translated into flags. No shell expansion or placeholders. */
const contextArgv = (context: SetupActionContext) => {
  const roots = context.inventory.overrides ?? {};
  return [
    "--home",
    context.home,
    "--json",
    ...(context.workDir === undefined ? [] : ["--work-dir", resolve(context.workDir)]),
    ...(roots.codex ?? []).flatMap((root) => ["--codex-root", root]),
    ...(roots["claude-code"] ?? []).flatMap((root) => ["--claude-root", root]),
    ...(roots.opencode ?? []).flatMap((root) => ["--opencode-root", root]),
    ...(roots.devin ?? []).flatMap((root) => ["--devin-root", root]),
  ];
};
const selectionArgv = (input: SetupCommandSelection) => [
  ...(input.selection
    ? [
        "--only-selected",
        ...(input.selection.useRetainedSkillIds ?? []).flatMap((id) => ["--use-retained", id]),
        ...(input.selection.useCopyPaths ?? []).flatMap((path) => ["--use-copy", path]),
        ...(input.selection.reconcileSkillIds ?? []).flatMap((id) => ["--reconcile-skill", id]),
        ...input.selection.sourceIds.flatMap((id) => ["--select-source", id]),
        ...input.selection.copyPaths.flatMap((path) => ["--select-path", path]),
        ...input.selection.removePaths.flatMap((path) => ["--remove-path", path]),
      ]
    : []),
  ...(input.duplicates === undefined ? [] : ["--duplicates", input.duplicates]),
];
export const setupScanAction = (context: SetupActionContext): CommandAction => ({
  rel: "observe",
  argv: ["skit", "setup", ...contextArgv(context)],
  effect: "read",
});
export const setupRecoveryListAction = (home: string): CommandAction => ({
  rel: "list-recovery",
  argv: ["skit", "library", "recovery", "list", "--home", home, "--json"],
  effect: "read",
});
export const setupReviewAction = (
  context: SetupActionContext,
  planId: string,
  selection: SetupCommandSelection,
): CommandAction => ({
  rel: "review",
  argv: ["skit", "setup", "--review", planId, ...selectionArgv(selection), ...contextArgv(context)],
  effect: "read",
});
export const setupApplyAction = (
  context: SetupActionContext,
  planId: string,
  reviewId: string,
  selection: SetupCommandSelection,
): CommandAction => ({
  rel: "apply",
  argv: [
    "skit",
    "setup",
    "--apply",
    planId,
    "--reviewed",
    reviewId,
    ...selectionArgv(selection),
    ...contextArgv(context),
  ],
  effect: "write",
});

export const setupResultActions = (
  context: SetupActionContext,
  applied: SetupApplied,
): CommandAction[] => [
  setupScanAction(context),
  setupRecoveryListAction(context.home),
  ...(applied.operationId
    ? [
        {
          rel: "preview-undo",
          argv: ["skit", "library", "undo", applied.operationId, "--home", context.home, "--json"],
          effect: "read" as const,
        },
      ]
    : []),
  ...[
    ...new Set([
      ...(applied.operationId ? [applied.operationId] : []),
      ...(applied.recoveryDirectories ?? applied.aliasRecoveryDirectories ?? []).map((path) =>
        basename(dirname(path)),
      ),
    ]),
  ].map((operation) => ({
    rel: "inspect-recovery",
    argv: ["skit", "library", "recovery", "inspect", operation, "--home", context.home, "--json"],
    effect: "read" as const,
  })),
];

/** Translate already validated application choices. Duplicate alternatives never originate here. */
export const setupDiscoveryOutput = (
  observed: SetupResult,
  review: SetupReview,
  context: SetupActionContext,
) => {
  const planId = observed.onboarding.planId;
  const empty = { sourceIds: [], copyPaths: [], removePaths: [] };
  const variants = (
    selection: SetupExplicitSelection | undefined,
    alternatives: readonly SetupDuplicateAction[],
  ) =>
    (alternatives.length ? alternatives : [undefined]).map((duplicates) =>
      setupReviewAction(context, planId, {
        ...(selection ? { selection } : {}),
        ...(duplicates === undefined ? {} : { duplicates }),
      }),
    );
  return {
    ...observed,
    actions: [
      setupScanAction(context),
      ...(observed.operationId
        ? [
            {
              rel: "inspect-recovery",
              argv: [
                "skit",
                "library",
                "recovery",
                "inspect",
                observed.operationId,
                "--home",
                context.home,
                "--json",
              ],
              effect: "read" as const,
            },
          ]
        : []),
      ...variants(undefined, review.recommendedChoices),
      setupRecoveryListAction(context.home),
      ...observed.suggestedRepositoryRoots.map((workDir) =>
        setupScanAction({ ...context, workDir }),
      ),
    ],
    choices: [
      ...review.versionAlternatives.map((choice) => ({
        kind: "version" as const,
        label:
          choice.version === "retained"
            ? `Use retained version of ${observed.changes?.find((fact) => fact.skillId === choice.skillId)?.name}`
            : `Use current copy at ${choice.path}`,
        skillId: choice.skillId,
        ...(choice.version === "retained" ? {} : { path: choice.path }),
        duplicateActions: [],
        actions: [
          ...(choice.version === "local"
            ? [
                {
                  rel: "compare",
                  effect: "read" as const,
                  argv: [
                    "skit",
                    "setup",
                    "--compare",
                    planId,
                    "--select-path",
                    choice.path,
                    ...contextArgv(context),
                  ],
                },
              ]
            : []),
          ...variants(
            choice.version === "retained"
              ? { ...empty, useRetainedSkillIds: [choice.skillId] }
              : { ...empty, useCopyPaths: [choice.path] },
            [],
          ),
        ],
      })),
      ...[...new Map((observed.changes ?? []).map((fact) => [fact.skillId, fact])).values()].map(
        (fact) => ({
          kind: "existing" as const,
          label: fact.name,
          skillId: fact.skillId,
          duplicateActions: [],
          actions: variants({ ...empty, reconcileSkillIds: [fact.skillId] }, []),
        }),
      ),
      ...review.sources.map((source) => ({
        kind: "source" as const,
        label: source.label,
        sourceId: source.id,
        duplicateActions: [],
        actions: variants({ ...empty, sourceIds: [source.id] }, []),
      })),
      ...review.copies.flatMap((copy) => [
        ...(copy.selectable
          ? [
              {
                kind: "copy" as const,
                label: copy.instance.name,
                path: copy.instance.path,
                duplicateActions: copy.duplicateActions,
                actions: [
                  {
                    rel: "compare",
                    argv: [
                      "skit",
                      "setup",
                      "--compare",
                      planId,
                      "--select-path",
                      copy.instance.path,
                      ...contextArgv(context),
                    ],
                    effect: "read" as const,
                  },
                  ...variants({ ...empty, copyPaths: [copy.instance.path] }, copy.duplicateActions),
                ],
              },
            ]
          : []),
        ...(copy.removeValue
          ? [
              {
                kind: "removal" as const,
                label: copy.instance.name,
                path: copy.instance.path,
                duplicateActions: [],
                actions: variants({ ...empty, removePaths: [copy.instance.path] }, []),
              },
            ]
          : []),
      ]),
    ],
  };
};

export function setupReviewSummary(summary: SetupReviewSummary) {
  return {
    sourceUpdateMayNeedReview: summary.sourceUpdateMayNeedReview,
    changes: summary.changes,
    versionChoices: summary.versionChoices,
    savesMachineSettings: summary.persistRoots,
    createsMachineIdentity: summary.createsMachineIdentity,
    sources: summary.sources.map(({ source, names }) => ({ source, names })),
    enables: summary.enables.map(({ name, sourcePath }) => ({ name, path: sourcePath })),
    retains: summary.retains.map(({ name, sourcePath }) => ({ name, path: sourcePath })),
    preserves: summary.preserves,
    removals: summary.removals.entries,
  };
}
