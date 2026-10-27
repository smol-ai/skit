import { resolve } from "node:path";
import { Effect, Option, Schema } from "effect";
import { Digest, LibraryStore } from "@smolai/skit-core";
import { Renderer } from "../../presentation/renderer.js";
import { OptionCombinationInvalid } from "../../workflows/failures.js";
import { runSetup, SetupPlanStale, type SetupOptions } from "../../workflows/library/setup.js";
import { openSetupReview } from "../../workflows/library/setup-review.js";
import type { ManageOptions } from "../../workflows/library/manage-existing.js";
import type { SetupDuplicateAction as SetupDuplicateActionType } from "../../workflows/library/setup-decisions.js";
import type { SetupApplied } from "../../workflows/library/setup-contract.js";
import type { SetupCommandSelection } from "../../commands/setup-actions.js";
import { setupReconciliationOutcomes } from "../../workflows/library/setup-reconciliation.js";

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
  readonly duplicates?: SetupDuplicateActionType;
  readonly selection?: SetupCommandSelection["selection"];
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
    input.manageOptions,
  );
  return { observed, review, planId: planId.value };
});

export const prepareSetupCommand = Effect.fn("CLI.setup.prepare")(function* (
  input: Parameters<typeof openSetupCommandReview>[0],
) {
  const { observed, review, planId } = yield* openSetupCommandReview(input);
  const plan = yield* input.selection
    ? review.prepareExplicit(input.selection, input.duplicates)
    : review.prepareRecommended(input.duplicates);
  return { observed, review, plan, planId };
});

export const setupApplyCommand = Effect.fn("CLI.setup.apply")(function* (
  input: Parameters<typeof prepareSetupCommand>[0] & { readonly reviewedPlanId?: string },
) {
  if (input.selection && input.reviewedPlanId === undefined)
    return yield* new OptionCombinationInvalid({
      detail: "Explicit selections require --reviewed with the reviewId from --review",
    });
  const renderer = yield* Renderer;
  const { observed, plan, planId } = yield* prepareSetupCommand(input);
  if (input.reviewedPlanId !== undefined && input.reviewedPlanId !== plan.reviewId)
    return yield* new OptionCombinationInvalid({
      detail: "The reviewed setup choices changed. Review these choices again before applying.",
    });
  const applied = plan.hasChanges ? yield* plan.apply(renderer.withStatus) : undefined;
  const { sources, additions, reconnects, removals } = plan.summary;
  const taken = new Set([
    ...sources.flatMap((source) => source.names),
    ...additions.map((copy) => copy.name),
    ...reconnects.map((copy) => copy.name),
    ...removals.entries.map((copy) => copy.name),
  ]);
  const store = yield* LibraryStore;
  const state = yield* store.load;
  const names = new Map(state.skills.map((skill) => [skill.skill_id, skill.name]));
  return {
    planId,
    reconciliation:
      applied?.reconciliation ?? setupReconciliationOutcomes(plan.summary.reconciliation, false),
    ...(applied ? { operationId: applied.operationId } : {}),
    removed: removals.entries.map(({ name, path }) => ({ name, path })),
    recoveryDirectories: [
      ...(applied?.recoveryDirectories ?? []),
      ...(removals.entries.length && applied ? [removals.recoveryDirectory] : []),
    ],
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
    ...(applied?.recoveryDirectories.length
      ? { aliasRecoveryDirectories: applied.recoveryDirectories }
      : {}),
    ...(applied?.warnings.length ? { aliasesKept: applied.warnings } : {}),
    ...(applied?.warnings.length ? { preservationWarnings: applied.warnings } : {}),
  } satisfies SetupApplied;
});
