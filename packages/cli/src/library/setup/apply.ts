import { setupStage } from "./progress.js";
import { resolve } from "node:path";
import { Effect, Option, Schema } from "effect";
import { Hash } from "@smolai/skit-core/shared";
import * as Library from "@smolai/skit-core/library";
import { Renderer } from "../../terminal/renderer.js";
import { OptionCombinationInvalid } from "../../commands/input-failures.js";
import {
  type SetupOptions,
  openApprovedSetupReview,
  type ManageOptions,
  type SetupDuplicateAction as SetupDuplicateActionType,
  type SetupApplied,
} from "@smolai/skit-core/library/setup";

import type { SetupCommandSelection } from "./actions.js";

/**
 * `skit setup --apply`: the non-interactive apply. The plan ID is the caller's consent: it must
 * match a fresh observation, and the recommendation it covers is applied through the same review
 * and apply as guided setup. Duplicate copies need an explicit choice. Explicit selections, including removals,
 * additionally require the reviewId of their passive review. The result says what was applied and why everything else was left alone, so a caller
 * never has to re-observe to find out whether the apply happened.
 */
export const openSetupCommandReview = Effect.fn("CLI.setup.openReview")(function* (input: {
  readonly options: Omit<SetupOptions, "repositoryRoots" | "persistRoots">;
  readonly manageOptions: ManageOptions;
  readonly workDirFlag?: string;
  readonly planId: string;
  readonly planOption?: "--apply" | "--review" | "--compare";
  readonly duplicates?: SetupDuplicateActionType;
  readonly selection?: SetupCommandSelection["selection"];
}) {
  const renderer = yield* Renderer;
  const planId = Schema.decodeOption(Hash)(input.planId);
  if (Option.isNone(planId))
    return yield* new OptionCombinationInvalid({
      reason: {
        _tag: "SetupPlanIdInvalid",
        option: input.planOption ?? "--apply",
        value: input.planId,
      },
    });
  const setupOptions: SetupOptions = {
    ...input.options,
    repositoryRoots: input.workDirFlag ? [resolve(input.workDirFlag)] : [],
    persistRoots: false,
  };
  const review = yield* renderer.withStatus(
    "Scanning local skills",
    openApprovedSetupReview(
      { ...setupOptions, persistRoots: input.workDirFlag !== undefined },
      planId.value,
      input.manageOptions,
    ),
  );
  return { scan: review.scan, review, planId: planId.value };
});

export const prepareSetupCommand = Effect.fn("CLI.setup.prepare")(function* (
  input: Parameters<typeof openSetupCommandReview>[0],
) {
  const { scan, review, planId } = yield* openSetupCommandReview(input);
  const plan = yield* input.selection
    ? review.prepareExplicit(input.selection, input.duplicates)
    : review.prepareRecommended(input.duplicates);
  return { scan, review, plan, planId };
});

export const setupApplyCommand = Effect.fn("CLI.setup.apply")(function* (
  input: Parameters<typeof prepareSetupCommand>[0] & { readonly reviewedPlanId?: string },
) {
  if (input.selection && input.reviewedPlanId === undefined)
    return yield* new OptionCombinationInvalid({
      reason: { _tag: "ReviewedSelectionRequired" },
    });
  const renderer = yield* Renderer;
  const { scan, plan, planId } = yield* prepareSetupCommand(input);
  if (input.reviewedPlanId !== undefined && input.reviewedPlanId !== plan.reviewId)
    return yield* new OptionCombinationInvalid({
      reason: {
        _tag: "ReviewedChoicesChanged",
        reviewedReviewId: input.reviewedPlanId,
        currentReviewId: plan.reviewId,
      },
    });
  const applied = plan.hasChanges ? yield* plan.apply(setupStage(renderer)) : undefined;
  const { sources, additions, reconnects, removals } = plan.summary;
  const taken = new Set([
    ...sources.flatMap((source) => source.names),
    ...additions.map((copy) => copy.name),
    ...reconnects.map((copy) => copy.name),
    ...removals.entries.map((copy) => copy.name),
  ]);
  const library = yield* Library.Service;
  const installedSkills = yield* library.installedSkills;
  return {
    planId,
    ...(applied ? { operationId: applied.operationId } : {}),
    removed: removals.entries.map(({ name, path }) => ({ name, path })),
    recoveryDirectories: [
      ...(applied?.recoveryDirectories ?? []),
      ...(applied?.removalDirectory === undefined ? [] : [applied.removalDirectory]),
    ],
    imported: sources.map(({ source, names }) => ({ source, names })),
    added: additions,
    reconnected: reconnects,
    installedSkills: installedSkills
      .filter((copy) => taken.has(copy.name))
      .map(({ name, destination, path, status }) => ({ name, destination, path, status })),
    leftAlone: scan.onboarding.candidates
      .filter((candidate) => !taken.has(candidate.name))
      .map((candidate) => ({
        name: candidate.name,
        paths: candidate.paths,
        reason: candidate.action === "blocked" ? candidate.reason : candidate.action,
      })),
    ...(applied?.recoveryDirectories.length
      ? { aliasRecoveryDirectories: applied.recoveryDirectories }
      : {}),
    ...(applied?.warnings.length ? { aliasesKept: applied.warnings } : {}),
    ...(applied?.warnings.length ? { backupWarnings: applied.warnings } : {}),
  } satisfies SetupApplied;
});
