import { openSetupCommandReview, prepareSetupCommand, setupApplyCommand } from "./setup-machine.js";
export { setupApplyCommand } from "./setup-machine.js";
import {
  SkitConfiguration,
  skitConfigurationLayer,
} from "../../configuration/skit-configuration.js";
import { skillModificationTime } from "../../library-application/skill-metadata.js";
import { Cause, Effect, FileSystem, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { join, resolve } from "node:path";
import { commandFailure, handleSourceCommand } from "../../application.js";
import { libraryCommandConfiguration } from "../../commands/library-configuration.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { inventoryRootOptions, localFlags, optionalString } from "../../commands/parameters.js";
import { Prompter, terminalPrompterLayer } from "../../presentation/prompter.js";
import { promptsAllowed } from "../../presentation/interactivity.js";
import { compactHomePath } from "../../presentation/home-path.js";
import { Renderer } from "../../presentation/renderer.js";
import {
  setupOverviewTitle,
  setupPrompts,
  setupStepPlan,
  type SetupStepPlan,
} from "../../presentation/setup-steps.js";
import { runSetup, type SetupOptions } from "../../workflows/library/setup.js";
import { openSetupReview, type SetupReview } from "../../workflows/library/setup-review.js";
import type { ManageOptions } from "../../workflows/library/manage-existing.js";
import { result } from "../contracts.js";
import {
  setupDiscoveryOutput,
  setupScanAction,
  setupRecoveryListAction,
  setupResultActions,
  setupReviewAction,
  setupApplyAction,
  setupReviewSummary,
} from "../../commands/setup-actions.js";
import { LibraryStore } from "@smolai/skit-core";
import { OptionCombinationInvalid } from "../../workflows/failures.js";
import { SetupDuplicateAction } from "../../workflows/library/setup-decisions.js";
import { checkSubjects } from "../../workflows/library/check.js";
import { renderCheck } from "../../presentation/check.js";
import { setupReviewSkillChoices } from "../../presentation/setup-skills.js";

import { renderSetupReconciliationOutcome } from "../../presentation/setup-reconciliation.js";
import {
  chooseSetupCopyDecisions,
  chooseSetupVersions,
  setupPlanLines,
  renderSetupAliasRecovery,
} from "../../presentation/setup-choice-presentation.js";

const workDirFlag = optionalString(
  "work-dir",
  "Repository root to remember for this machine and scan.",
);
const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Observe without updating machine configuration."),
  Flag.withDefault(false),
);
const applyFlag = optionalString(
  "apply",
  "Apply this observed planId without prompting; explicit selections also need --reviewed.",
);
const reviewFlag = optionalString(
  "review",
  "Preview explicit or recommended choices against this observed planId without applying.",
);
const compareFlag = optionalString(
  "compare",
  "Compare observed copies of the selected skill paths against this planId.",
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
  selectPath: repeated("select-path", "Choose this observed copy path; repeat to choose more."),
  selectSource: repeated(
    "select-source",
    "Choose this public source identifier from setup JSON; repeat to choose more.",
  ),
  removePath: repeated(
    "remove-path",
    "Preserve this eligible installed copy in recovery; repeat to choose more.",
  ),
};
const duplicatesFlag = Flag.Literals("duplicates", SetupDuplicateAction.literals).pipe(
  Flag.withDescription(
    "Override automatic preservation for selected skills: retain-only keeps Library artifacts without enabling; keep-both keeps existing copies active; retire-aliases preserves individual links; preserve-duplicates preserves eligible equal global directories.",
  ),
  Flag.optional,
);

export const setupCommand = Effect.fn("CLI.setup")(function* (input: {
  readonly options: Omit<SetupOptions, "repositoryRoots" | "persistRoots">;
  readonly manageOptions?: ManageOptions;
  readonly interactive: boolean;
  readonly dryRun: boolean;
  readonly workDirFlag?: string;
}) {
  const roots = input.workDirFlag ? [resolve(input.workDirFlag)] : [];
  const persistRoots = Boolean(input.workDirFlag) && !input.dryRun;
  let setupOptions: SetupOptions = {
    ...input.options,
    repositoryRoots: roots,
    persistRoots: false,
  };
  const renderer = yield* Renderer;
  const guided = input.interactive && !input.dryRun && input.manageOptions !== undefined;
  const steps = setupStepPlan({ scanRepositories: roots.length > 0 });
  if (guided) yield* renderer.note(steps.overview, setupOverviewTitle);
  const observe = (options: SetupOptions) =>
    renderer.withStatus("Observing local skills", runSetup(options));
  let observed = yield* observe(setupOptions);
  if (!input.interactive && persistRoots) {
    const review = yield* openSetupReview(
      { ...setupOptions, persistRoots: true },
      observed,
      input.manageOptions ?? { bindings: setupOptions.inventory },
    );
    // The explicit work-dir flag approves only this settings change, not skill enablement.
    const plan = yield* review.prepare({
      sources: [],
      copies: [],
      decisions: [],
      reconcileExisting: false,
    });
    const applied = yield* plan.apply(renderer.withStatus);
    const refreshed = yield* observe(setupOptions);
    return {
      ...refreshed,
      machineConfig: { ...refreshed.machineConfig, persisted: true },
      operationId: applied.operationId,
    };
  }
  if (!guided || !input.manageOptions) return observed;
  const discoveredRepositories = observed.repositories;
  const displayPath = (path: string) => compactHomePath(path, input.options.inventory.home);
  const displayRoots = roots.map(displayPath).join(", ");
  if (roots.length)
    yield* renderer.step(
      steps.step("repositories"),
      discoveredRepositories.length
        ? `Found ${discoveredRepositories.length} ${discoveredRepositories.length === 1 ? "repository" : "repositories"} with skills under ${displayRoots}. SKIT ignores the ones you leave unselected.`
        : `No repositories with skills were found under ${displayRoots}.`,
    );
  let repositoryDecisions: ReadonlyArray<{
    path: string;
    status: "watched" | "ignored";
  }> = [];
  if (discoveredRepositories.length) {
    const prompter = yield* Prompter;
    const watched = yield* prompter.multiselect(
      setupPrompts.repositories,
      discoveredRepositories.map((repository) => ({
        value: repository.path,
        label: displayPath(repository.path),
        hint: `${repository.skills.length} skill${repository.skills.length === 1 ? "" : "s"}`,
        selected: repository.status !== "ignored",
      })),
    );
    const watchedPaths = new Set(watched);
    repositoryDecisions = discoveredRepositories.map((repository) => ({
      path: repository.path,
      status: watchedPaths.has(repository.path) ? ("watched" as const) : ("ignored" as const),
    }));
    setupOptions = {
      ...setupOptions,
      repositoryDecisions,
      scanDecidedRepositories: true,
    };
    observed = yield* observe({ ...setupOptions, persistRoots: false });
  }
  const review = yield* openSetupReview(
    { ...setupOptions, persistRoots },
    observed,
    input.manageOptions,
  );
  const sources = yield* chooseKnownSources(steps, review);
  const copies = yield* chooseDiscoveredSkills(steps, review, input.options.inventory.home);
  const decisions = yield* chooseSetupCopyDecisions(
    yield* review.selectedCopies(copies),
    displayPath,
  );
  const versionChoices = yield* chooseSetupVersions(
    review.versionAlternatives,
    observed.reconciliation ?? [],
    displayPath,
  );
  const plan = yield* review.prepare({ sources, copies, decisions, versionChoices });
  if (!plan.canApply) return yield* plan.apply(renderer.withStatus).pipe(Effect.as(observed));
  if (!plan.hasChanges) {
    yield* renderer.step(
      steps.step("confirm"),
      "Nothing was selected and the repository roots are unchanged, so there is nothing to apply.",
    );
    yield* offerSkillsShUpdateCheck();
    return observed;
  }
  yield* renderer.step(
    steps.step("confirm"),
    setupPlanLines({
      summary: plan.summary,
      displayRoots,
      displayPath,
    }).join("\n"),
  );
  const prompter = yield* Prompter;
  if (!(yield* prompter.confirm(setupPrompts.confirm))) {
    yield* renderer.note("No changes were applied.", "Setup cancelled");
    return observed;
  }
  const applied = yield* plan.apply(renderer.withStatus);
  yield* renderSetupAliasRecovery(applied);
  if (plan.summary.removals.entries.length)
    yield* renderer.note(
      `Removed installed locations are saved at ${plan.summary.removals.recoveryDirectory}. Inspect them with skit library recovery list --home ${JSON.stringify(input.options.libraryHome)}. File recovery does not undo setup bindings or settings.`,
      "Removed copies saved",
    );
  yield* renderer.note(
    [
      "Selected setup changes were applied.",
      ...applied.reconciliation.map((outcome) => renderSetupReconciliationOutcome(outcome)),
      `Setup operation: ${applied.operationId}. Preview full undo with skit library undo ${applied.operationId} using the same --home.`,
    ].join("\n"),
    "Setup complete",
  );
  yield* offerSkillsShUpdateCheck();
  return applied.observed;
});

const offerSkillsShUpdateCheck = Effect.fn("CLI.setup.offerSkillsShUpdateCheck")(function* () {
  const store = yield* LibraryStore;
  const state = yield* store.load;
  const collectionIds = [
    ...new Set(
      state.acquisitions
        .filter((acquisition) =>
          acquisition.observations.some((observation) => observation.type === "skills.sh-lock"),
        )
        .map((acquisition) => acquisition.collection_id),
    ),
  ];
  if (!collectionIds.length) return;
  const prompter = yield* Prompter;
  if (
    !(yield* prompter.confirm(
      `Check ${collectionIds.length} retained skills.sh Source${collectionIds.length === 1 ? "" : "s"} for updates now?`,
    ))
  )
    return;
  const renderer = yield* Renderer;
  const checks = yield* renderer.withStatus(
    "Checking retained skills.sh Sources",
    Effect.flatMap(
      Effect.forEach(collectionIds, (collectionId) => checkSubjects(state, collectionId)),
      (results) => Effect.succeed(results.flat()),
    ),
  );
  yield* renderer.note(renderCheck(checks), "Source updates");
});

const chooseKnownSources = Effect.fn("CLI.setup.chooseKnownSources")(function* (
  steps: SetupStepPlan,
  review: SetupReview,
) {
  const sources = review.sources;
  const renderer = yield* Renderer;
  if (!sources.length) {
    yield* renderer.step(steps.step("collections"), "No skills.sh collections to add.");
    return [];
  }
  yield* renderer.step(
    steps.step("collections"),
    `Found ${sources.length} installed skills.sh collection${sources.length === 1 ? "" : "s"} not yet in the SKIT Library.`,
  );
  const prompter = yield* Prompter;
  const selectedSources = yield* prompter
    .multiselect(
      setupPrompts.collections,
      sources.map((source) => ({
        value: source.key,
        label: source.label,
        hint: `${source.skillCount} installed ${source.skillCount === 1 ? "skill" : "skills"}`,
        selected: true,
      })),
    )
    .pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed([])));
  return selectedSources;
});

const chooseDiscoveredSkills = Effect.fn("CLI.setup.chooseDiscoveredSkills")(function* (
  steps: SetupStepPlan,
  review: SetupReview,
  home: string,
) {
  const prompter = yield* Prompter;
  const fs = yield* FileSystem.FileSystem;
  const rows = setupReviewSkillChoices(review.copies, review.recommended, home);
  const choices = yield* Effect.forEach(rows, (row) =>
    Effect.gen(function* () {
      const modified = yield* skillModificationTime(row.instance.path);
      const path = join(row.instance.path, "SKILL.md");
      return {
        ...row.choice,
        searchText: `${row.details} · SKILL.md modified ${modified?.slice(0, 10) ?? "unavailable"}`,
        preview: () =>
          fs.readFileString(path).pipe(
            Effect.map(
              (content) =>
                `${path}\n${row.details}\nSKILL.md modified ${modified?.slice(0, 10) ?? "unavailable"}\n\n${content.length > 65_536 ? `${content.slice(0, 65_536)}\n\n[Preview truncated at 65,536 characters]` : content}`,
            ),
            Effect.orElseSucceed(
              () =>
                `${path}\n${row.details}\nSKILL.md modified ${modified?.slice(0, 10) ?? "unavailable"}\n\nContent unavailable: the file could not be read.`,
            ),
          ),
      };
    }),
  );
  const skillNames = new Set(rows.map((row) => row.instance.name)).size;
  const renderer = yield* Renderer;
  yield* renderer.step(
    steps.step("skills"),
    choices.length
      ? `Found ${skillNames} other installed skill${skillNames === 1 ? "" : "s"} in ${rows.length} location${rows.length === 1 ? "" : "s"}.`
      : "No other installed skills to review.",
  );
  const selectedValues = choices.length
    ? yield* prompter
        .multiselect(setupPrompts.skills, choices)
        .pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed([])))
    : [];
  return selectedValues;
});

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
      return yield* handleSourceCommand(
        Effect.gen(function* () {
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
              const manageOptions = { bindings: configuration.pull.bindings };
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
                const opened = yield* openSetupCommandReview({ ...selected, planId: compare });
                const copies = yield* opened.review.compareCopies(
                  choice.selection?.copyPaths ?? [],
                );
                const discovery = setupDiscoveryOutput(opened.observed, opened.review, context);
                return result("setupComparison", {
                  planId: opened.planId,
                  copies,
                  actions: [
                    setupScanAction(context),
                    ...discovery.choices
                      .filter(
                        (item) =>
                          (item.kind === "copy" &&
                            copies.some((copy) => copy.path === item.path)) ||
                          (item.kind === "version" &&
                            opened.observed.reconciliation?.some(
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
                const prepared = yield* prepareSetupCommand({ ...selected, planId: reviewId });
                return result("setupReview", {
                  planId: prepared.planId,
                  reviewId: prepared.plan.reviewId,
                  hasChanges: prepared.plan.hasChanges,
                  canApply: prepared.plan.canApply,
                  summary: setupReviewSummary(prepared.plan.summary),
                  actions: [
                    setupScanAction(context),
                    setupReviewAction(context, prepared.planId, choice),
                    ...setupDiscoveryOutput(prepared.observed, prepared.review, context)
                      .choices.filter(
                        (item) =>
                          item.kind === "version" &&
                          prepared.plan.summary.reconciliation.some(
                            (fact) => fact.skillId === item.skillId,
                          ),
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
                return result("setupApplied", {
                  ...applied,
                  actions: setupResultActions(context, applied),
                });
              }
              const value = yield* setupCommand({
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
              const review = yield* openSetupReview(setup, value, manageOptions);
              return result("setup", setupDiscoveryOutput(value, review, context));
            }),
          );
          if (execution._tag === "Failure") {
            const failed = commandFailure(Cause.fail(execution.failure));
            return yield* renderer.result(
              result(
                "setupFailed",
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
        }).pipe(Effect.provide(terminalPrompterLayer)),
      );
    }).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(input.home)))),
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
      outputContracts.setup,
      outputContracts.setupApplied,
      outputContracts.setupReview,
      outputContracts.setupFailed,
      outputContracts.setupComparison,
    ],
    exitCodes: [0, 1, 11, 12, 64, 65],
    interactive: true,
  }),
);
