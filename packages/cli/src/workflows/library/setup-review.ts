import { Data, Effect } from "effect";
import { FailureTypeId, MachineSettings, type SkitFailure } from "@smolai/skit-core";
import { OptionCombinationInvalid } from "../failures.js";
import { captureLocalAdoptionAliases, type LocalAdoptionOptions } from "./local-adoption.js";
import { applySetupPlan, type SetupApplyOptions, type SetupApproval } from "./setup-apply.js";
import type { SetupOptions } from "./setup.js";
import type { SetupResult, SetupKnownSourceSelection } from "./setup-contract.js";
import {
  isSetupProjectionTarget,
  setupReviewCopies,
  setupSelectedCopies,
  type SetupCopyDecision,
  type SetupDuplicateAction,
  type SetupSelectedCopy,
} from "./setup-decisions.js";
import { planSetupRemovals, setupRemovablePaths } from "./setup-removal.js";

/**
 * Applying the recommended plan would create another agent-visible copy of these skills, and
 * nobody has said how to resolve that. Non-interactive setup never guesses.
 */
export class SetupDuplicateDecisionRequired
  extends Data.TaggedError("SetupDuplicateDecisionRequired")<{
    names: readonly string[];
    retirable: boolean;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  get remediation() {
    return `Pass --duplicates retain-only to keep them in the Library without enabling, --duplicates keep-both to enable them alongside the existing copies${this.retirable ? ", or --duplicates retire-aliases to replace the redundant symlinks" : ""}.`;
  }
  get message() {
    return `Enabling ${this.names.join(", ")} would create another copy agents already see`;
  }
}

/** Hold the observed choices and their meaning through preparation and confirmation. */
export const openSetupReview = Effect.fn("Setup.openReview")(function* (
  options: SetupOptions,
  observation: SetupResult,
  adoption: LocalAdoptionOptions,
) {
  const setup = structuredClone(options);
  const localCustody = structuredClone(adoption);
  const observed = structuredClone(observation);
  const configured = yield* MachineSettings.read(setup.libraryHome);
  const previous = new Map(configured.repositories.map((item) => [item.path, item.status]));
  const repositoryDecisions = setup.repositoryDecisions ?? [];
  const persistRoots =
    setup.persistRoots ||
    repositoryDecisions.some((item) => previous.get(item.path) !== item.status);
  const copies = setupReviewCopies(observed.instances, observed.onboarding.candidates);
  const removablePaths = yield* setupRemovablePaths(setup, observed);
  const sources = new Map<
    string,
    {
      key: string;
      label: string;
      candidates: Extract<
        SetupResult["onboarding"]["candidates"][number],
        { action: "import-observed-collection" }
      >[];
    }
  >();
  for (const candidate of observed.onboarding.candidates) {
    if (candidate.action !== "import-observed-collection") continue;
    const prior = sources.get(candidate.groupKey);
    sources.set(candidate.groupKey, {
      key: candidate.groupKey,
      label: candidate.source,
      candidates: [...(prior?.candidates ?? []), candidate],
    });
  }
  const invalid = (detail: string) => new OptionCombinationInvalid({ detail });
  const selectedCopies = Effect.fn("Setup.selectedCopies")(function* (values: readonly string[]) {
    const add = [];
    const bind = [];
    for (const value of new Set(values)) {
      const copy = copies.find((item) => item.value === value);
      if (copy?.selectable && copy.candidate) {
        const selection = { name: copy.instance.name, sourcePath: copy.instance.path };
        if (copy.candidate.action === "bind-existing-entry") bind.push(selection);
        else add.push(selection);
        continue;
      }
      const removal = copies.find((item) => `remove\0${item.value}` === value);
      if (removal && (removablePaths.get(removal.instance.path)?.length ?? 0) > 0) continue;
      return yield* invalid("Choose an available setup action from the observed review");
    }
    return structuredClone(setupSelectedCopies(observed, add, bind));
  });
  const prepare = Effect.fn("Setup.prepareReview")(function* (selection: {
    readonly sources: readonly string[];
    readonly copies: readonly string[];
    readonly decisions: readonly SetupCopyDecision[];
  }) {
    const chosen = yield* selectedCopies(selection.copies);
    if (chosen.length !== selection.decisions.length)
      return yield* invalid("Review the duplicate-copy decisions for every selected setup copy");
    const decisions: SetupCopyDecision[] = [];
    for (const copy of chosen) {
      const matches = selection.decisions.filter(
        (item) => item.name === copy.name && item.sourcePath === copy.sourcePath,
      );
      const decision = matches[0];
      if (matches.length !== 1 || decision === undefined)
        return yield* invalid("Review the duplicate-copy decision for this setup copy");
      // The review owns operation and conflict; callers supply only the user's consent.
      decisions.push({ ...decision, ...copy });
    }
    const imports: SetupKnownSourceSelection[] = [];
    for (const key of new Set(selection.sources)) {
      const source = sources.get(key);
      if (source === undefined) return yield* invalid("Choose an observed setup Source");
      imports.push(
        ...source.candidates.map((candidate) => ({
          name: candidate.name,
          paths: candidate.paths,
          groupKey: candidate.groupKey,
        })),
      );
    }
    imports.sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.paths.join("\0").localeCompare(right.paths.join("\0")),
    );
    const removals = copies
      .filter((copy) => selection.copies.includes(`remove\0${copy.value}`))
      .map((copy) => ({ name: copy.instance.name, paths: [copy.instance.path] }));
    const approval: SetupApproval = {
      setup,
      planId: observed.onboarding.planId,
      persistRoots,
      imports,
      bindings: decisions.filter((copy) => copy.operation === "bind"),
      custody: decisions.filter((copy) => copy.operation === "add"),
      removals: yield* planSetupRemovals(setup, observed, removals, removablePaths),
    };
    const repositoryCopies = approval.custody.filter((copy) =>
      observed.instances.some(
        (instance) =>
          instance.path === copy.sourcePath &&
          (instance.git.repository !== undefined || !isSetupProjectionTarget(instance)),
      ),
    );
    const displayCopy = (copy: { readonly name: string; readonly sourcePath: string }) => ({
      name: copy.name,
      sourcePath: copy.sourcePath,
    });
    const summary = {
      persistRoots,
      repositoryDecisions,
      createsMachineIdentity: imports.length > 0 && !observed.machineConfig.machineId,
      sources: [...new Set(imports.map((item) => item.groupKey))].map((key) => {
        const source = sources.get(key)?.candidates[0];
        return {
          source: source?.source ?? key,
          lockContentHash: source?.lockContentHash ?? "",
          names: imports
            .filter((item) => item.groupKey === key)
            .map((item) => item.name)
            .sort(),
        };
      }),
      reconnects: approval.bindings
        .filter((copy) => copy.duplicateAction !== "retain-only")
        .map(displayCopy),
      additions: approval.custody.map(displayCopy),
      custodyCount: approval.custody.filter(
        (copy) => !repositoryCopies.includes(copy) && copy.duplicateAction !== "retain-only",
      ).length,
      repositoryCopiesRemain: repositoryCopies.length > 0,
      authoritativeCopies: approval.custody
        .filter((copy) =>
          observed.onboarding.candidates.some(
            (candidate) =>
              candidate.paths.includes(copy.sourcePath) &&
              candidate.action === "blocked" &&
              candidate.reason === "divergent-copies",
          ),
        )
        .map(displayCopy),
      duplicates: (["retain-only", "retire-aliases", "keep-both"] as const).flatMap((action) => {
        const selected = decisions.filter((decision) => decision.duplicateAction === action);
        return selected.length
          ? [
              {
                action,
                names: selected.map((copy) => copy.name),
                aliasCount: new Set(
                  selected.flatMap(
                    (copy) => copy.approvedAliases?.map((alias) => alias.path) ?? [],
                  ),
                ).size,
              },
            ]
          : [];
      }),
      removals: {
        entries: approval.removals.entries,
        recoveryDirectory: approval.removals.recoveryDirectory,
      },
    };
    // Neither presentation facts nor caller-owned consent arrays may redirect confirmation.
    const approved = {
      ...approval,
      setup: structuredClone(setup),
      imports: structuredClone(imports),
      bindings: structuredClone(approval.bindings),
      custody: structuredClone(approval.custody),
    };
    return {
      hasChanges:
        persistRoots ||
        imports.length > 0 ||
        decisions.length > 0 ||
        approval.removals.entries.length > 0,
      summary: structuredClone(summary),
      apply: (withStatus: SetupApplyOptions["withStatus"]) =>
        applySetupPlan({ adoption: localCustody, withStatus }, approved),
    };
  });
  const recommended = observed.onboarding.recommended;
  /**
   * The recommended selection, with one answer for every copy that would duplicate an existing
   * one. This is the non-interactive counterpart of the guided prompts: same review, same
   * validation, and consent comes from the plan ID the caller reviewed.
   */
  const prepareRecommended = Effect.fn("Setup.prepareRecommended")(function* (
    duplicates: SetupDuplicateAction | undefined,
  ) {
    const values: string[] = [];
    for (const recommendation of recommended.copies) {
      const copy = copies.find(
        (item) =>
          item.instance.name === recommendation.name &&
          item.instance.path === recommendation.sourcePath,
      );
      if (copy === undefined) return yield* invalid("The recommended copy is not in the review");
      values.push(copy.value);
    }
    const chosen = yield* selectedCopies(values);
    const conflicting = chosen.filter((copy) => copy.conflict.kind !== "none");
    if (conflicting.length && duplicates === undefined)
      return yield* new SetupDuplicateDecisionRequired({
        names: conflicting.map((copy) => copy.name),
        retirable: conflicting.every((copy) => copy.conflict.kind === "retirable"),
      });
    const decide = Effect.fn("Setup.decideRecommendedCopy")(function* (
      copy: SetupSelectedCopy,
    ): Effect.fn.Return<
      SetupCopyDecision,
      OptionCombinationInvalid | Effect.Error<ReturnType<typeof captureLocalAdoptionAliases>>,
      Effect.Services<ReturnType<typeof captureLocalAdoptionAliases>>
    > {
      if (copy.conflict.kind === "none" || duplicates === undefined) return copy;
      if (duplicates !== "retire-aliases") return { ...copy, duplicateAction: duplicates };
      if (copy.conflict.kind !== "retirable")
        return yield* invalid(
          `${copy.name} has copies that are not individual symlinks; use --duplicates retain-only or keep-both`,
        );
      const approvedAliases = yield* captureLocalAdoptionAliases(
        copy.sourcePath,
        copy.conflict.shadows,
      );
      return { ...copy, duplicateAction: duplicates, approvedAliases };
    });
    return yield* prepare({
      sources: recommended.sources.map((source) => source.groupKey),
      copies: values,
      decisions: yield* Effect.forEach(chosen, decide),
    });
  });
  return {
    sources: [...sources.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((source) => ({
        key: source.key,
        label: source.label,
        skillCount: source.candidates.length,
      })),
    copies: structuredClone(
      copies.map((copy) => ({
        ...copy,
        ...((removablePaths.get(copy.instance.path)?.length ?? 0) > 0
          ? { removeValue: `remove\0${copy.value}` }
          : {}),
      })),
    ),
    selectedCopies,
    recommended: structuredClone(recommended),
    prepare,
    prepareRecommended,
  };
});
export type SetupReview = Effect.Success<ReturnType<typeof openSetupReview>>;
export type SetupReviewSummary = Effect.Success<ReturnType<SetupReview["prepare"]>>["summary"];
