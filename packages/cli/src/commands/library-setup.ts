import {
  openSetupCommandReview,
  prepareSetupCommand,
  setupApplyCommand,
  setupOutputContracts,
  setupDiscoveryOutput,
  setupScanAction,
  setupRecoveryListAction,
  setupResultActions,
  setupReviewAction,
  setupApplyAction,
  setupReviewSummary,
  setupCommand,
} from "../library/setup.js";
import { SkitConfiguration } from "@smolai/skit-core/platform";
import { Cause, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { resolve } from "node:path";
import { commandFailure, handleSourceCommand } from "./handler.js";
import { libraryCommandConfiguration } from "./library-configuration.js";
import { CommandMetadata } from "./metadata.js";

import { inventoryRootOptions, localFlags, optionalString } from "./parameters.js";
import { promptsAllowed } from "../terminal/interactivity.js";
import { Renderer } from "../terminal/renderer.js";
import { openSetupReview, SetupDuplicateAction } from "@smolai/skit-core/library/setup";
import { encodeResult as result } from "./encode-result.js";

import { OptionCombinationInvalid } from "./input-failures.js";

const workDirFlag = optionalString(
  "work-dir",
  "Repository root to remember for this machine and scan.",
);

const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Scan without saving machine settings."),
  Flag.withDefault(false),
);

const applyFlag = optionalString(
  "apply",
  "Apply this planId without prompting; explicit selections also need --reviewed.",
);

const reviewFlag = optionalString(
  "review",
  "Preview explicit or recommended choices against this planId without applying.",
);

const compareFlag = optionalString(
  "compare",
  "Compare the copies found at the selected skill paths against this planId.",
);

const reviewedFlag = optionalString(
  "reviewed",
  "The reviewId returned by --review; required when applying explicit selections.",
);

const repeated = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.atLeast(0));

const selectionFlags = {
  useRetained: repeated(
    "use-retained",
    "Use the retained active version for this competing Skill identifier.",
  ),
  useCopy: repeated(
    "use-copy",
    "Use this current copy as the active version of its competing Skill.",
  ),
  reconcileSkill: repeated(
    "reconcile-skill",
    "Review this already-enabled Skill without selecting unrelated sources; repeat to choose more.",
  ),
  onlySelected: Flag.Boolean("only-selected").pipe(
    Flag.withDescription(
      "Use only the explicitly selected sources/copies/removals, including an empty selection.",
    ),
    Flag.withDefault(false),
  ),
  selectPath: repeated(
    "select-path",
    "Choose this copy path from the scan; repeat to choose more.",
  ),
  selectSource: repeated(
    "select-source",
    "Choose this public source identifier from setup JSON; repeat to choose more.",
  ),
  removePath: repeated(
    "remove-path",
    "Move this installed copy into recovery; repeat to choose more.",
  ),
};

const duplicatesFlag = Flag.Literals("duplicates", SetupDuplicateAction.literals).pipe(
  Flag.withDescription(
    "Choose what happens to other copies of the selected skills: retain-only imports into the Library without enabling; keep-both enables and leaves the other copies; retire-aliases enables and moves symlinks to the skill into recovery; preserve-duplicates enables and moves identical global copies into recovery.",
  ),
  Flag.optional,
);

export const setupCliCommand = Command.make(
  "setup",
  {
    workDir: workDirFlag,
    dryRun,
    apply: applyFlag,
    review: reviewFlag,
    compare: compareFlag,
    reviewed: reviewedFlag,
    duplicates: duplicatesFlag,
    ...selectionFlags,
    ...localFlags,
  },
  (input) =>
    handleSourceCommand(
      Effect.gen(function* () {
        const paths = yield* SkitConfiguration;
        const selectedHome = paths.skitHome;
        const apply = Option.getOrUndefined(input.apply);
        const reviewId = Option.getOrUndefined(input.review);
        const compare = Option.getOrUndefined(input.compare);
        const reviewedPlanId = Option.getOrUndefined(input.reviewed);
        const duplicates = Option.getOrUndefined(input.duplicates);
        const workDir = Option.getOrUndefined(input.workDir);
        const explicit =
          input.onlySelected ||
          input.selectPath.length > 0 ||
          input.selectSource.length > 0 ||
          input.removePath.length > 0 ||
          input.reconcileSkill.length > 0 ||
          input.useRetained.length > 0 ||
          input.useCopy.length > 0;
        const choice = {
          ...(explicit
            ? {
                selection: {
                  reconcileSkillIds: input.reconcileSkill,
                  useRetainedSkillIds: input.useRetained,
                  useCopyPaths: input.useCopy.map((path) => resolve(path)),
                  sourceIds: input.selectSource,
                  copyPaths: input.selectPath.map((path) => resolve(path)),
                  removePaths: input.removePath.map((path) => resolve(path)),
                },
              }
            : {}),
          ...(duplicates === undefined ? {} : { duplicates }),
        };
        const interactive =
          apply === undefined &&
          reviewId === undefined &&
          compare === undefined &&
          !input.dryRun &&
          promptsAllowed({ json: input.json, needsStdout: true });
        const renderer = yield* Renderer;
        const context = {
          home: selectedHome,
          inventory: inventoryRootOptions(input, paths),
          ...(workDir === undefined ? {} : { workDir }),
        };
        const execution = yield* Effect.result(
          Effect.gen(function* () {
            const configuration = yield* libraryCommandConfiguration(input);
            const options = {
              libraryHome: selectedHome,
              inventory: configuration.inventory,
              probePath: process.env.PATH,
              skillsStateHome: paths.xdgStateHome,
            };
            const manageOptions = {
              installOptions: configuration.pull.installOptions,
            };
            if (
              [apply, reviewId, compare].filter((value) => value !== undefined).length > 1 ||
              (apply !== undefined && input.dryRun)
            )
              return yield* new OptionCombinationInvalid({
                detail: "Use --review to preview or --apply to apply, one at a time",
              });
            if (
              (duplicates !== undefined || explicit) &&
              apply === undefined &&
              reviewId === undefined &&
              compare === undefined
            )
              return yield* new OptionCombinationInvalid({
                detail:
                  "Selections require --review, --compare or --apply; duplicate decisions apply to review/apply",
              });
            if (reviewedPlanId !== undefined && apply === undefined)
              return yield* new OptionCombinationInvalid({
                detail: "--reviewed requires --apply",
              });
            const selected = {
              options,
              manageOptions,
              ...(workDir === undefined ? {} : { workDirFlag: workDir }),
              ...choice,
            };
            if (compare !== undefined) {
              if (
                duplicates !== undefined ||
                input.selectSource.length ||
                input.reconcileSkill.length ||
                input.useRetained.length ||
                input.useCopy.length ||
                input.removePath.length ||
                input.onlySelected
              )
                return yield* new OptionCombinationInvalid({
                  detail: "--compare accepts --select-path choices only",
                });
              const opened = yield* openSetupCommandReview({
                ...selected,
                planId: compare,
              });
              const copies = yield* opened.review.compareCopies(choice.selection?.copyPaths ?? []);
              const discovery = setupDiscoveryOutput(opened.scan, opened.review, context);
              return result("setupComparison", setupOutputContracts.setupComparison, {
                planId: opened.planId,
                copies,
                actions: [
                  setupScanAction(context),
                  ...discovery.choices
                    .filter(
                      (item) =>
                        (item.kind === "copy" && copies.some((copy) => copy.path === item.path)) ||
                        (item.kind === "version" &&
                          opened.scan.changes?.some(
                            (fact) =>
                              fact.skillId === item.skillId &&
                              copies.some((copy) => copy.name === fact.name),
                          )),
                    )
                    .flatMap((item) => item.actions.filter((action) => action.rel === "review")),
                ],
              });
            }
            if (reviewId !== undefined) {
              const prepared = yield* prepareSetupCommand({
                ...selected,
                planId: reviewId,
              });
              return result("setupReview", setupOutputContracts.setupReview, {
                planId: prepared.planId,
                reviewId: prepared.plan.reviewId,
                hasChanges: prepared.plan.hasChanges,
                canApply: prepared.plan.canApply,
                summary: setupReviewSummary(prepared.plan.summary),
                actions: [
                  setupScanAction(context),
                  setupReviewAction(context, prepared.planId, choice),
                  ...setupDiscoveryOutput(prepared.scan, prepared.review, context)
                    .choices.filter(
                      (item) =>
                        item.kind === "version" &&
                        prepared.plan.summary.changes.some((fact) => fact.skillId === item.skillId),
                    )
                    .flatMap((item) => item.actions),
                  ...(prepared.plan.canApply
                    ? [setupApplyAction(context, prepared.planId, prepared.plan.reviewId, choice)]
                    : []),
                ],
              });
            }
            if (apply !== undefined) {
              const applied = yield* setupApplyCommand({
                ...selected,
                planId: apply,
                ...(reviewedPlanId === undefined ? {} : { reviewedPlanId }),
              });
              return result("setupApplied", setupOutputContracts.setupApplied, {
                ...applied,
                actions: setupResultActions(context, applied),
              });
            }
            yield* setupCommand({
              ...(workDir === undefined ? {} : { workDirFlag: workDir }),
              interactive,
              dryRun: input.dryRun || input.json,
              options,
              manageOptions,
            });
            if (interactive) return undefined;
            const setup = {
              ...options,
              repositoryRoots: workDir ? [resolve(workDir)] : [],
              persistRoots: false,
            };
            const review = yield* openSetupReview(setup, manageOptions);
            return result(
              "setup",
              setupOutputContracts.setup,
              setupDiscoveryOutput(review.scan, review, context),
            );
          }),
        );
        if (execution._tag === "Failure") {
          const failed = commandFailure(Cause.fail(execution.failure));
          return yield* renderer.result(
            result(
              "setupFailed",
              setupOutputContracts.setupFailed,
              {
                code: failed.code,
                message: failed.message,
                remediation: failed.remediation,
                actions: [setupScanAction(context), setupRecoveryListAction(selectedHome)],
              },
              failed.exitCode,
            ),
          );
        }
        if (execution.success) yield* renderer.result(execution.success);
      }),
      Option.getOrUndefined(input.home),
    ),
).pipe(
  Command.withDescription(
    "Find the skills already on this machine and bring them under SKIT: guided in a terminal, or review with --json and apply with --apply.",
  ),
  Command.withExamples([
    { command: "skit setup" },
    { command: "skit setup --work-dir ~/Work" },
    { command: "skit setup --json --work-dir ~/Work" },
    { command: "skit setup --apply sha256:<planId> --work-dir ~/Work" },
  ]),
  Command.annotate(CommandMetadata, {
    effects: {
      capabilities: ["filesystem.read", "filesystem.write", "network.read", "process.execute"],
      subprocesses: [
        "git ls-files",
        "git status --porcelain",
        "git clone --mirror",
        "git fetch --all --prune",
        "git rev-parse",
        "git ls-tree",
        "git cat-file blob",
        "git log",
        "codex --version",
        "claude --version",
        "opencode --version",
        "devin --version",
      ],
    },
    outputSchemas: [
      setupOutputContracts.setup,
      setupOutputContracts.setupApplied,
      setupOutputContracts.setupReview,
      setupOutputContracts.setupFailed,
      setupOutputContracts.setupComparison,
    ],
    exitCodes: [0, 1, 11, 12, 64, 65],
    interactive: true,
  }),
);
