import { SkitConfiguration } from "@smolai/skit-core/platform";
import { readSkillsShCollectionIds, readSkillPreviews } from "@smolai/skit-core/library/session";
import { Effect } from "effect";

import { resolve } from "node:path";

import { Prompter } from "../terminal/prompter.js";
import { compactHomePath } from "../terminal/home-path.js";
import { Renderer } from "../terminal/renderer.js";
import {
  setupOverviewTitle,
  setupPrompts,
  setupStepPlan,
  type SetupStepPlan,
} from "./setup/steps.js";
import {
  type SetupOptions,
  openSetupReview,
  type SetupReview,
  type ManageOptions,
} from "@smolai/skit-core/library/setup";
import { checkSubjects, renderCheck } from "./check.js";
import { setupReviewSkillChoices } from "./setup/skills.js";
import { renderChangeResult } from "./presentation/installed-skill-changes.js";
import {
  chooseSetupCopyDecisions,
  chooseSetupVersions,
  setupPlanLines,
  renderSetupAliasRecovery,
} from "./setup/choices.js";

export { setupApplyCommand } from "./setup/apply.js";

export const setupCommand = Effect.fn("CLI.setup")(function* (input: {
  readonly options: Omit<SetupOptions, "repositoryRoots" | "persistRoots">;
  readonly manageOptions?: ManageOptions;
  readonly interactive: boolean;
  readonly dryRun: boolean;
  readonly workDirFlag?: string;
}) {
  const roots = input.workDirFlag ? [resolve(input.workDirFlag)] : [];
  const persistRoots = Boolean(input.workDirFlag) && !input.dryRun;
  const setupOptions: SetupOptions = {
    ...input.options,
    repositoryRoots: roots,
    persistRoots: false,
  };
  const renderer = yield* Renderer;
  const guided = input.interactive && !input.dryRun && input.manageOptions !== undefined;
  const steps = setupStepPlan({ scanRepositories: roots.length > 0 });
  if (guided) yield* renderer.note(steps.overview, setupOverviewTitle);
  // One owner call opens the review on its own scan; prompts refresh it, never re-scan themselves.
  let review = yield* renderer.withStatus(
    "Observing local skills",
    openSetupReview(
      { ...setupOptions, persistRoots },
      input.manageOptions ?? { installOptions: setupOptions.inventory },
    ),
  );
  if (!input.interactive && persistRoots) {
    // The explicit work-dir flag approves only this settings change, not skill enablement.
    const plan = yield* review.prepare({
      sources: [],
      copies: [],
      decisions: [],
      reconcileExisting: false,
    });
    const applied = yield* plan.apply(renderer.withStatus);
    return {
      ...applied.scan,
      machineConfig: { ...applied.scan.machineConfig, persisted: true },
      operationId: applied.operationId,
    };
  }
  if (!guided || !input.manageOptions) return review.scan;
  const discoveredRepositories = review.scan.repositories;
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
    review = yield* renderer.withStatus(
      "Observing local skills",
      review.refresh({ repositoryDecisions, scanDecidedRepositories: true }),
    );
  }
  const scan = review.scan;
  const sources = yield* chooseKnownSources(steps, review);
  const copies = yield* chooseDiscoveredSkills(steps, review, input.options.inventory.home);
  const decisions = yield* chooseSetupCopyDecisions(
    yield* review.selectedCopies(copies),
    displayPath,
  );
  const versionChoices = yield* chooseSetupVersions(
    review.versionAlternatives,
    scan.changes ?? [],
    displayPath,
  );
  const plan = yield* review.prepare({ sources, copies, decisions, versionChoices });
  if (!plan.canApply) return yield* plan.apply(renderer.withStatus).pipe(Effect.as(scan));
  if (!plan.hasChanges) {
    yield* renderer.step(
      steps.step("confirm"),
      "Nothing was selected and the repository roots are unchanged, so there is nothing to apply.",
    );
    yield* offerSkillsShUpdateCheck();
    return scan;
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
    return scan;
  }
  const applied = yield* plan.apply(renderer.withStatus);
  yield* renderSetupAliasRecovery(applied);
  if (applied.removalDirectory !== undefined)
    yield* renderer.note(
      `Removed installed locations are saved at ${applied.removalDirectory}. Inspect them with skit library recovery list --home ${JSON.stringify(input.options.libraryHome)}. File recovery does not undo setup bindings or settings.`,
      "Removed copies saved",
    );
  yield* renderer.note(
    [
      "Selected setup changes were applied.",
      ...applied.changes.map((outcome) => renderChangeResult(outcome)),
      `Setup operation: ${applied.operationId}. Preview full undo with skit library undo ${applied.operationId} using the same --home.`,
    ].join("\n"),
    "Setup complete",
  );
  yield* offerSkillsShUpdateCheck();
  return applied.scan;
});

const offerSkillsShUpdateCheck = Effect.fn("CLI.setup.offerSkillsShUpdateCheck")(function* () {
  const collectionIds = yield* readSkillsShCollectionIds((yield* SkitConfiguration).skitHome);
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
      Effect.forEach(collectionIds, (collectionId) => checkSubjects(collectionId)),
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
  const rows = setupReviewSkillChoices(review.copies, review.recommended, home);
  const previews = new Map(
    (yield* readSkillPreviews(rows.map((row) => row.instance.path))).map((preview) => [
      preview.path,
      preview,
    ]),
  );
  const choices = rows.map((row) => {
    const preview = previews.get(row.instance.path)!;
    const modified = preview.modifiedAt;
    const path = preview.documentPath;
    return {
      ...row.choice,
      searchText: `${row.details} · SKILL.md modified ${modified?.slice(0, 10) ?? "unavailable"}`,
      preview: () =>
        preview.content.pipe(
          Effect.map(
            (content) =>
              `${path}\n${row.details}\nSKILL.md modified ${modified?.slice(0, 10) ?? "unavailable"}\n\n${
                content === undefined
                  ? "Content unavailable: the file could not be read."
                  : content.length > 65_536
                    ? `${content.slice(0, 65_536)}\n\n[Preview truncated at 65,536 characters]`
                    : content
              }`,
          ),
        ),
    };
  });
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

export { setupOutputContracts } from "./setup/output.js";

export { setupUndoActions, renderSetupUndo } from "./setup/undo-result.js";

export {
  renderSetup,
  renderSetupApplied,
  renderSetupComparison,
  renderSetupReview,
  renderSetupFailed,
} from "./setup/present.js";
export { prepareSetupUndo } from "./setup/undo.js";

export { openSetupCommandReview } from "./setup/apply.js";

export { prepareSetupCommand } from "./setup/apply.js";

export { setupDiscoveryOutput } from "./setup/actions.js";

export { setupScanAction } from "./setup/actions.js";

export { setupRecoveryListAction } from "./setup/actions.js";

export { setupResultActions } from "./setup/actions.js";

export { setupReviewAction } from "./setup/actions.js";

export { setupApplyAction } from "./setup/actions.js";

export { setupReviewSummary } from "./setup/actions.js";
