import {
  SkitConfiguration,
  skitConfigurationLayer,
} from "../../configuration/skit-configuration.js";
import { skillModificationTime } from "../../library-application/skill-metadata.js";
import { Effect, FileSystem, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { join, resolve } from "node:path";
import { handleSourceCommand } from "../../application.js";
import { libraryCommandConfiguration } from "../../commands/library-configuration.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { localFlags, optionalString } from "../../commands/parameters.js";
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
import type { LocalAdoptionOptions } from "../../workflows/library/local-adoption.js";
import { result } from "../contracts.js";
import { Digest, LibraryStore } from "@smolai/skit-core";
import type { SetupApplied } from "../../workflows/library/setup-contract.js";
import { OptionCombinationInvalid } from "../../workflows/failures.js";
import { SetupPlanStale } from "../../workflows/library/setup.js";
import {
  SetupDuplicateAction,
  type SetupDuplicateAction as SetupDuplicateActionType,
} from "../../workflows/library/setup-decisions.js";
import { checkSubjectsEffect } from "../../workflows/library/check.js";
import { renderCheck } from "../../presentation/check.js";
import { setupReviewSkillChoices } from "../../presentation/setup-skills.js";

import {
  chooseSetupCopyDecisions,
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
  "Apply the recommended plan with this planId (from `skit setup --json`) without prompting.",
);
const duplicatesFlag = Flag.Literals("duplicates", SetupDuplicateAction.literals).pipe(
  Flag.withDescription(
    "With --apply, how to handle skills agents already see elsewhere: retain-only keeps them in the Library without enabling, keep-both enables them anyway, retire-aliases replaces redundant symlinks.",
  ),
  Flag.optional,
);

export const setupCommand = Effect.fn("CLI.setup")(function* (input: {
  readonly options: Omit<SetupOptions, "repositoryRoots" | "persistRoots">;
  readonly localCustody?: LocalAdoptionOptions;
  readonly interactive: boolean;
  readonly dryRun: boolean;
  readonly workDirFlag?: string;
}) {
  const roots = input.workDirFlag ? [resolve(input.workDirFlag)] : [];
  const persistRoots = Boolean(input.workDirFlag) && !input.dryRun;
  let setupOptions: SetupOptions = {
    ...input.options,
    repositoryRoots: roots,
    persistRoots: !input.interactive && persistRoots,
  };
  const renderer = yield* Renderer;
  const guided = input.interactive && !input.dryRun && input.localCustody !== undefined;
  const steps = setupStepPlan({ scanRepositories: roots.length > 0 });
  if (guided) yield* renderer.note(steps.overview, setupOverviewTitle);
  const observe = (options: SetupOptions) =>
    renderer.withStatus("Observing local skills", runSetup(options));
  let observed = yield* observe(setupOptions);
  if (!guided || !input.localCustody) return observed;
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
    input.localCustody,
  );
  const sources = yield* chooseKnownSources(steps, review);
  const copies = yield* chooseDiscoveredSkills(steps, review, input.options.inventory.home);
  const decisions = yield* chooseSetupCopyDecisions(
    yield* review.selectedCopies(copies),
    displayPath,
  );
  const plan = yield* review.prepare({ sources, copies, decisions });
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
      `Removed installed locations are saved at ${plan.summary.removals.recoveryDirectory}. Move each entry back to its original path recorded in receipt.json to restore it.`,
      "Removed copies saved",
    );
  yield* renderer.note("Selected setup changes were applied.", "Setup complete");
  yield* offerSkillsShUpdateCheck();
  return applied.observed;
});

/**
 * `skit setup --apply`: the non-interactive apply. The plan ID is the caller's consent: it must
 * match a fresh observation, and the recommendation it covers is applied through the same review
 * and apply as guided setup. Duplicate copies need an explicit `--duplicates`; removals are never
 * applied. The result says what was applied and why everything else was left alone, so a caller
 * never has to re-observe to find out whether the apply happened.
 */
export const setupApplyCommand = Effect.fn("CLI.setup.apply")(function* (input: {
  readonly options: Omit<SetupOptions, "repositoryRoots" | "persistRoots">;
  readonly localCustody: LocalAdoptionOptions;
  readonly workDirFlag?: string;
  readonly planId: string;
  readonly duplicates?: SetupDuplicateActionType;
}) {
  const renderer = yield* Renderer;
  const planId = Schema.decodeUnknownOption(Digest)(input.planId);
  if (Option.isNone(planId))
    return yield* new OptionCombinationInvalid({
      detail: "--apply takes the full planId that `skit setup` prints",
    });
  const setupOptions: SetupOptions = {
    ...input.options,
    repositoryRoots: input.workDirFlag ? [resolve(input.workDirFlag)] : [],
    persistRoots: false,
  };
  const observed = yield* renderer.withStatus("Observing local skills", runSetup(setupOptions));
  if (observed.onboarding.planId !== planId.value)
    return yield* new SetupPlanStale({
      approvedPlanId: planId.value,
      currentPlanId: observed.onboarding.planId,
    });
  const review = yield* openSetupReview(
    { ...setupOptions, persistRoots: input.workDirFlag !== undefined },
    observed,
    input.localCustody,
  );
  const plan = yield* review.prepareRecommended(input.duplicates);
  if (plan.hasChanges) yield* plan.apply(renderer.withStatus);
  const { sources, additions, reconnects } = plan.summary;
  const taken = new Set([
    ...sources.flatMap((source) => source.names),
    ...additions.map((copy) => copy.name),
    ...reconnects.map((copy) => copy.name),
  ]);
  const store = yield* LibraryStore;
  const state = yield* store.load;
  const names = new Map(state.skills.map((skill) => [skill.skill_id, skill.name]));
  return {
    planId: planId.value,
    imported: sources.map(({ source, names }) => ({ source, names })),
    added: additions,
    reconnected: reconnects,
    projections: state.projections.flatMap((projection) => {
      const name = names.get(projection.skill_id);
      return name !== undefined && taken.has(name)
        ? [{ name, target: projection.target, path: projection.path, status: projection.status }]
        : [];
    }),
    leftAlone: observed.onboarding.candidates
      .filter((candidate) => !taken.has(candidate.name))
      .map((candidate) => ({
        name: candidate.name,
        paths: candidate.paths,
        reason: candidate.action === "blocked" ? candidate.reason : candidate.action,
      })),
  } satisfies SetupApplied;
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
      Effect.forEach(collectionIds, (collectionId) => checkSubjectsEffect(state, collectionId)),
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
  { workDir: workDirFlag, dryRun, apply: applyFlag, duplicates: duplicatesFlag, ...localFlags },
  (input) =>
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;

      const selectedHome = paths.skitHome;
      const apply = Option.getOrUndefined(input.apply);
      const duplicates = Option.getOrUndefined(input.duplicates);
      const interactive =
        apply === undefined &&
        !input.dryRun &&
        promptsAllowed({ json: input.json, needsStdout: true });
      return yield* handleSourceCommand(
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          if (apply !== undefined && input.dryRun)
            return yield* new OptionCombinationInvalid({
              detail: "--apply applies a plan; preview it with `skit setup --json` instead",
            });
          if (duplicates !== undefined && apply === undefined)
            return yield* new OptionCombinationInvalid({ detail: "--duplicates requires --apply" });
          const configuration = yield* libraryCommandConfiguration(input);
          const workDirFlag = Option.getOrUndefined(input.workDir);
          const options = {
            libraryHome: selectedHome,
            inventory: configuration.inventory,
            probePath: process.env.PATH,
            skillsStateHome: paths.xdgStateHome,
          };
          const localCustody = { bindings: configuration.pull.bindings };
          if (apply !== undefined)
            return yield* renderer.result(
              result(
                "setupApplied",
                yield* setupApplyCommand({
                  options,
                  localCustody,
                  planId: apply,
                  ...(workDirFlag === undefined ? {} : { workDirFlag }),
                  ...(duplicates === undefined ? {} : { duplicates }),
                }),
              ),
            );
          const value = yield* setupCommand({
            ...(workDirFlag === undefined ? {} : { workDirFlag }),
            interactive,
            // JSON output observes only; it never reaches the guided apply.
            dryRun: input.dryRun || input.json,
            options,
            localCustody,
          });
          if (!interactive) yield* renderer.result(result("setup", value));
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
      capabilities: ["filesystem.read", "filesystem.write", "network.write", "process.execute"],
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
    outputSchemas: [outputContracts.setup, outputContracts.setupApplied],
    exitCodes: [0, 1, 11, 12, 64, 65],
    interactive: true,
  }),
);
