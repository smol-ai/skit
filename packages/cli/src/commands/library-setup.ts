import { duplicatesFlag } from "../library/setup/duplicate-options.js";
import { defineCommand } from "./definition.js";
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
import { commandError } from "./failure-classification.js";
import { CommandMetadata } from "./metadata.js";

import { inventoryRootOptions, localFlags, optionalString } from "./parameters.js";
import { promptsAllowed } from "../terminal/interactivity.js";
import { Renderer } from "../terminal/renderer.js";
import { openSetupReview } from "@smolai/skit-core/library/setup";
import { encodeResult as result } from "./encode-result.js";

import { OptionCombinationInvalid } from "./input-failures.js";

const reviewedRule = "--reviewed requires --apply";

const selectionRule =
  "Selections require --review, --compare or --apply; duplicate decisions apply to review/apply";

const modeRule =
  "Use only one of --review, --compare or --apply; --apply cannot be combined with --dry-run.";

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

export const setupCliCommand = defineCommand(
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
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;
      const selectedHome = paths.skitHome;
      const {
        apply,
        review: reviewId,
        compare,
        reviewed: reviewedPlanId,
        duplicates,
        workDir,
      } = input;
      const selectionOptions = [
        ...(input.onlySelected ? ["--only-selected"] : []),
        ...(input.selectPath.length ? ["--select-path"] : []),
        ...(input.selectSource.length ? ["--select-source"] : []),
        ...(input.removePath.length ? ["--remove-path"] : []),
      ];
      const explicit = selectionOptions.length > 0;
      const choice = {
        ...(explicit
          ? {
              selection: {
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
          const options = {
            libraryHome: selectedHome,
            inventory: context.inventory,
            probePath: process.env.PATH,
            skillsStateHome: paths.xdgStateHome,
          };
          const manageOptions = {
            installOptions: context.inventory,
          };
          if (
            [apply, reviewId, compare].filter((value) => value !== undefined).length > 1 ||
            (apply !== undefined && input.dryRun)
          )
            return yield* new OptionCombinationInvalid({
              reason: {
                _tag: "ConflictingOptions",
                options: [
                  ...(apply === undefined ? [] : ["--apply"]),
                  ...(reviewId === undefined ? [] : ["--review"]),
                  ...(compare === undefined ? [] : ["--compare"]),
                  ...(apply !== undefined && input.dryRun ? ["--dry-run"] : []),
                ],
              },
            });
          if (
            (duplicates !== undefined || explicit) &&
            apply === undefined &&
            reviewId === undefined &&
            compare === undefined
          )
            return yield* new OptionCombinationInvalid({
              reason: {
                _tag: "RequiresMode",
                options: [
                  ...selectionOptions,
                  ...(duplicates === undefined ? [] : ["--duplicates"]),
                ],
                modes: ["--review", "--compare", "--apply"],
              },
            });
          if (reviewedPlanId !== undefined && apply === undefined)
            return yield* new OptionCombinationInvalid({
              reason: { _tag: "RequiresOption", options: ["--reviewed"], required: "--apply" },
            });
          const selected = {
            options,
            manageOptions,
            ...(workDir === undefined ? {} : { workDirFlag: workDir }),
            ...choice,
          };
          if (compare !== undefined) {
            const unsupported = [
              ...selectionOptions.filter((option) => option !== "--select-path"),
              ...(duplicates === undefined ? [] : ["--duplicates"]),
            ];
            if (unsupported.length)
              return yield* new OptionCombinationInvalid({
                reason: {
                  _tag: "OptionsNotAllowed",
                  mode: "--compare",
                  options: unsupported,
                  allowed: ["--select-path"],
                },
              });
            const opened = yield* openSetupCommandReview({
              ...selected,
              planId: compare,
              planOption: "--compare",
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
                      item.kind === "copy" && copies.some((copy) => copy.path === item.path),
                  )
                  .flatMap((item) => item.actions.filter((action) => action.rel === "review")),
              ],
            });
          }
          if (reviewId !== undefined) {
            const prepared = yield* prepareSetupCommand({
              ...selected,
              planId: reviewId,
              planOption: "--review",
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
        const failed = commandError(Cause.fail(execution.failure));
        return yield* renderer.result(
          result("setupFailed", setupOutputContracts.setupFailed, {
            ...failed,
            actions: [setupScanAction(context), setupRecoveryListAction(selectedHome)],
          }),
        );
      }
      if (execution.success) yield* renderer.result(execution.success);
    }),
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
    handlerRules: [modeRule, selectionRule, reviewedRule],
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
    interactive: true,
  }),
);
