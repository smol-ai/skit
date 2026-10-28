import { join } from "node:path";
import { Data, Effect, FileSystem } from "effect";
import {
  deterministicTreeHash,
  canonicalJson,
  hashParts,
  FailureTypeId,
  MachineSettings,
  type SkitFailure,
} from "@smolai/skit-core";
import { OptionCombinationInvalid } from "../failures.js";
import { recordDuplicateSymlinks, type ManageOptions } from "./manage-existing.js";
import { applySetupPlan, type SetupApplyOptions, type SetupApproval } from "./setup-apply.js";
import type { SetupOptions } from "./setup.js";
import type {
  SetupResult,
  SetupKnownSourceSelection,
  SetupVersionChoice,
} from "./setup-contract.js";
import {
  isSetupInstallDestination,
  setupReviewCopies,
  setupSelectedCopies,
  setupSourceChoiceId,
  setupDuplicateActions,
  setupDuplicateChoiceRequired,
  copyConflict,
  type SetupExplicitSelection,
  type SetupCopyDecision,
  type SetupCopyChoice,
  type SetupCopyConflict,
  type SetupDuplicateAction,
} from "./setup-decisions.js";
import { setupVersionAlternatives } from "./setup-version-choice.js";
import { planSetupRemovals, setupRemovablePaths } from "./setup-removal.js";
import { recordSetupCopies } from "./setup-copy-backup.js";
import { hasChangesToApply, changesNeedingChoice } from "./installed-skill-changes.js";

/**
 * Applying the recommended plan would create another agent-visible copy of these skills, and
 * nobody has said how to resolve that. Non-interactive setup never guesses.
 */
export class SetupDuplicateDecisionRequired
  extends Data.TaggedError("SetupDuplicateDecisionRequired")<{
    names: readonly string[];
    retirable: boolean;
    /** False when one of them is linked where SKIT writes its copy, so both cannot stay. */
    keepBoth: boolean;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  get remediation() {
    return `Pass --duplicates retain-only to keep them in the Library without enabling${this.keepBoth ? ", --duplicates keep-both to enable them alongside the existing copies" : ""}${this.retirable ? ", or --duplicates retire-aliases to replace the redundant symlinks" : ""}.`;
  }
  get message() {
    return `Enabling ${this.names.join(", ")} would create another copy agents already see`;
  }
}

/** Hold the observed choices and their meaning through preparation and confirmation. */
export const openSetupReview = Effect.fn("Setup.openReview")(function* (
  options: SetupOptions,
  observation: SetupResult,
  manage: ManageOptions,
) {
  const setup = structuredClone(options);
  const manageOptions = structuredClone(manage);
  const observed = structuredClone(observation);
  const configured = yield* MachineSettings.read(setup.libraryHome);
  const previous = new Map(configured.repositories.map((item) => [item.path, item.status]));
  const repositoryDecisions = setup.repositoryDecisions ?? [];
  const persistRoots =
    setup.persistRoots ||
    repositoryDecisions.some((item) => previous.get(item.path) !== item.status);
  const copies = setupReviewCopies(observed.instances, observed.onboarding.candidates);
  const copyConflicts = new Map<string, SetupCopyConflict>();
  for (const copy of copies) {
    let conflict = copyConflict(observed, {
      name: copy.instance.name,
      sourcePath: copy.instance.path,
    });
    if (conflict.kind === "preservable") {
      const checked = yield* Effect.result(
        recordSetupCopies(copy.instance.path, conflict.duplicates),
      );
      if (checked._tag === "Failure") conflict = { ...conflict, kind: "preserve-copies" };
    }
    copyConflicts.set(copy.instance.path, conflict);
  }
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
    return structuredClone(
      setupSelectedCopies(observed, add, bind).map((copy) => ({
        ...copy,
        conflict: copyConflicts.get(copy.sourcePath) ?? copy.conflict,
      })),
    );
  });
  const prepare = Effect.fn("Setup.prepareReview")(function* (selection: {
    readonly sources: readonly string[];
    readonly copies: readonly string[];
    readonly decisions: readonly SetupCopyChoice[];
    readonly reconcileExisting?: boolean;
    readonly reconciliationSkills?: readonly string[];
    readonly versionChoices?: readonly SetupVersionChoice[];
  }) {
    const versionChoices = selection.versionChoices ?? [];
    const alternatives = setupVersionAlternatives(observed.changes ?? []);
    if (
      new Set(versionChoices.map((choice) => choice.skillId)).size !== versionChoices.length ||
      versionChoices.some(
        (choice) =>
          !alternatives.some((alternative) => canonicalJson(alternative) === canonicalJson(choice)),
      )
    )
      return yield* invalid("Choose one available active version for each competing Skill");
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
      // Front ends supply intent; only this owner captures filesystem approval evidence.
      const action =
        decision.duplicateAction ??
        (copy.conflict.kind === "retirable"
          ? "retire-aliases"
          : copy.conflict.kind === "preservable"
            ? "preserve-duplicates"
            : undefined);
      if (copy.conflict.kind === "none") {
        decisions.push(action === "retain-only" ? { ...copy, duplicateAction: action } : copy);
        continue;
      }
      if (action === undefined)
        return yield* new SetupDuplicateDecisionRequired({
          names: [copy.name],
          retirable: false,
          keepBoth: !copy.conflict.replacesLink,
        });
      if (action === "keep-both" && copy.conflict.replacesLink)
        return yield* invalid(
          `${copy.name} is linked where SKIT writes its copy, so both cannot stay`,
        );
      if (action === "preserve-duplicates") {
        if (copy.conflict.kind !== "preservable")
          return yield* invalid(`${copy.name} does not have eligible equal global copies`);
        decisions.push({
          ...copy,
          duplicateAction: action,
          approvedCopies: yield* recordSetupCopies(
            copy.sourcePath,
            copy.conflict.duplicates,
            decision.approvedCopies,
          ),
        });
        continue;
      }
      if (action !== "retire-aliases") {
        decisions.push({ ...copy, duplicateAction: action });
        continue;
      }
      if (copy.conflict.kind !== "retirable")
        return yield* invalid(`${copy.name} has copies that are not individual symlinks`);
      decisions.push({
        ...copy,
        duplicateAction: action,
        approvedSymlinks: yield* recordDuplicateSymlinks(
          copy.sourcePath,
          copy.conflict.duplicates,
          decision.approvedSymlinks,
        ),
      });
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
    const selectedExistingSkills = new Set(
      decisions
        .filter((copy) => copy.operation === "bind")
        .flatMap(
          (copy) =>
            observed.instances
              .find((instance) => instance.path === copy.sourcePath)
              ?.contentIdentity.libraryMatches.map((match) => match.skillId) ?? [],
        ),
    );
    const approval: SetupApproval = {
      setup,
      planId: observed.onboarding.planId,
      persistRoots,
      imports,
      bindings: decisions.filter((copy) => copy.operation === "bind"),
      ownership: decisions.filter((copy) => copy.operation === "add"),
      removals: yield* planSetupRemovals(setup, observed, removals, removablePaths),
      versionChoices: structuredClone(versionChoices),
      changes: structuredClone(
        (observed.changes ?? []).filter(
          (fact) =>
            selection.reconcileExisting !== false ||
            selectedExistingSkills.has(fact.skillId) ||
            selection.reconciliationSkills?.includes(fact.skillId) ||
            versionChoices.some((choice) => choice.skillId === fact.skillId),
        ),
      ),
    };
    const repositoryCopies = approval.ownership.filter((copy) =>
      observed.instances.some(
        (instance) =>
          instance.path === copy.sourcePath &&
          (instance.git.repository !== undefined || !isSetupInstallDestination(instance)),
      ),
    );
    const displayCopy = (copy: { readonly name: string; readonly sourcePath: string }) => ({
      name: copy.name,
      sourcePath: copy.sourcePath,
    });
    const summary = {
      sourceUpdateMayNeedReview: imports.length > 0 && (observed.changes?.length ?? 0) > 0,
      changes: approval.changes ?? [],
      versionChoices,
      persistRoots,
      repositoryDecisions,
      createsMachineIdentity:
        (imports.length > 0 || approval.ownership.length > 0) && !observed.machineConfig.machineId,
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
      enables: decisions
        .filter(
          (copy) =>
            copy.duplicateAction !== "retain-only" &&
            isSetupInstallDestination(
              observed.instances.find((instance) => instance.path === copy.sourcePath),
            ) &&
            !observed.onboarding.candidates.some(
              (candidate) =>
                candidate.action === "repository-owned" &&
                candidate.paths.includes(copy.sourcePath),
            ),
        )
        .map(displayCopy),
      importOnly: decisions
        .filter(
          (copy) =>
            copy.duplicateAction === "retain-only" ||
            !isSetupInstallDestination(
              observed.instances.find((instance) => instance.path === copy.sourcePath),
            ) ||
            observed.onboarding.candidates.some(
              (candidate) =>
                candidate.action === "repository-owned" &&
                candidate.paths.includes(copy.sourcePath),
            ),
        )
        .map(displayCopy),
      reconnects: approval.bindings
        .filter((copy) => copy.duplicateAction !== "retain-only")
        .map(displayCopy),
      preserves: decisions.flatMap((copy) => [
        ...(copy.approvedSymlinks ?? []).map((alias) => ({
          name: copy.name,
          path: alias.path,
          kind: "symlink" as const,
        })),
        ...(copy.approvedCopies ?? []).map((entry) => ({
          name: copy.name,
          path: entry.path,
          kind: "directory" as const,
        })),
      ]),
      additions: approval.ownership.map(displayCopy),
      custodyCount: approval.ownership.filter(
        (copy) => !repositoryCopies.includes(copy) && copy.duplicateAction !== "retain-only",
      ).length,
      repositoryCopiesRemain: repositoryCopies.length > 0,
      authoritativeCopies: approval.ownership
        .filter((copy) =>
          observed.onboarding.candidates.some(
            (candidate) =>
              candidate.paths.includes(copy.sourcePath) &&
              candidate.action === "blocked" &&
              candidate.reason === "divergent-copies",
          ),
        )
        .map(displayCopy),
      duplicates: (
        ["retain-only", "retire-aliases", "keep-both", "preserve-duplicates"] as const
      ).flatMap((action) => {
        const selected = decisions.filter((decision) => decision.duplicateAction === action);
        return selected.length
          ? [
              {
                action,
                names: selected.map((copy) => copy.name),
                aliasCount: new Set(
                  selected.flatMap((copy) => [
                    ...(copy.approvedSymlinks?.map((alias) => alias.path) ?? []),
                    ...(copy.approvedCopies?.map((entry) => entry.path) ?? []),
                  ]),
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
      custody: structuredClone(approval.ownership),
    };
    return {
      canApply: !changesNeedingChoice(approval.changes ?? [], versionChoices).length,
      reviewId: hashParts([
        canonicalJson({
          planId: observed.onboarding.planId,
          setup,
          changes: approval.changes,
          versionChoices,
          sources: [...selection.sources].sort(),
          copies: [...selection.copies].sort(),
          decisions: [...decisions].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)),
        }),
      ]),
      hasChanges:
        persistRoots ||
        imports.length > 0 ||
        decisions.length > 0 ||
        approval.removals.entries.length > 0 ||
        hasChangesToApply(approval.changes ?? [], versionChoices) ||
        changesNeedingChoice(approval.changes ?? [], versionChoices).length > 0,
      summary: structuredClone(summary),
      apply: (withStatus: SetupApplyOptions["withStatus"]) =>
        applySetupPlan({ manage: manageOptions, withStatus }, approved),
    };
  });
  const recommended = observed.onboarding.recommended;
  const recommendedValues: string[] = [];
  for (const recommendation of recommended.copies) {
    const copy = copies.find(
      (item) =>
        item.instance.name === recommendation.name &&
        item.instance.path === recommendation.sourcePath,
    );
    if (copy === undefined) return yield* invalid("The recommended copy is not in the review");
    recommendedValues.push(copy.value);
  }
  const prepareChoices = Effect.fn("Setup.prepareChoices")(function* (
    sourceKeys: readonly string[],
    values: readonly string[],
    duplicates: SetupDuplicateAction | undefined,
    reconcileExisting = true,
    reconciliationSkills: readonly string[] = [],
    versionChoices: readonly SetupVersionChoice[] = [],
  ) {
    const chosen = yield* selectedCopies(values);
    const conflicting = chosen.filter(setupDuplicateChoiceRequired);
    const alternatives = setupDuplicateActions(chosen);
    if (conflicting.length && duplicates === undefined)
      return yield* new SetupDuplicateDecisionRequired({
        names: conflicting.map((copy) => copy.name),
        retirable: alternatives.includes("retire-aliases"),
        keepBoth: alternatives.includes("keep-both"),
      });
    return yield* prepare({
      reconcileExisting,
      reconciliationSkills,
      versionChoices,
      sources: sourceKeys,
      copies: values,
      decisions: chosen.map((copy) => ({
        ...copy,
        ...(duplicates === undefined ? {} : { duplicateAction: duplicates }),
      })),
    });
  });
  const explicitChoices = Effect.fn("Setup.explicitChoices")(function* (
    selection: SetupExplicitSelection,
  ) {
    for (const id of selection.reconcileSkillIds ?? []) {
      if (!(observed.changes ?? []).some((fact) => fact.skillId === id))
        return yield* invalid("Choose an observed existing Skill identifier");
    }
    const sourceKeys: string[] = [];
    for (const id of new Set(selection.sourceIds)) {
      const source = [...sources.values()].find((item) => setupSourceChoiceId(item.key) === id);
      if (!source) return yield* invalid("Choose an available setup source identifier");
      sourceKeys.push(source.key);
    }
    const values: string[] = [];
    for (const path of new Set(selection.copyPaths)) {
      const copy = copies.find((item) => item.instance.path === path && item.selectable);
      if (!copy) return yield* invalid("Choose an available setup copy path");
      values.push(copy.value);
    }
    for (const path of new Set(selection.removePaths)) {
      const copy = copies.find(
        (item) => item.instance.path === path && (removablePaths.get(path)?.length ?? 0) > 0,
      );
      if (!copy || selection.copyPaths.includes(path))
        return yield* invalid("Choose a removable copy without also selecting it for enablement");
      values.push(`remove\0${copy.value}`);
    }
    const selected = yield* selectedCopies(values);
    return { sourceKeys, values, duplicateActions: setupDuplicateActions(selected) };
  });
  const compareCopies = Effect.fn("Setup.compareCopies")(function* (paths: readonly string[]) {
    const fs = yield* FileSystem.FileSystem;
    const names = new Set<string>();
    for (const path of paths) {
      const copy = observed.instances.find((item) => item.path === path);
      if (!copy) return yield* invalid("Choose an observed copy to compare");
      names.add(copy.name);
    }
    if (!names.size) return yield* invalid("Choose at least one observed copy to compare");
    const compared = [];
    for (const instance of observed.instances.filter((item) => names.has(item.name))) {
      const markdown = yield* fs.readFileString(join(instance.path, "SKILL.md"));
      const currentHash = yield* deterministicTreeHash(instance.path);
      if (currentHash !== instance.contentIdentity.observedHash)
        return yield* invalid("This copy changed; observe setup again before comparing");
      compared.push({
        name: instance.name,
        path: instance.path,
        observedHash: currentHash,
        markdown: markdown.slice(0, 65_536),
        truncated: markdown.length > 65_536,
      });
    }
    return compared.sort((left, right) => left.path.localeCompare(right.path));
  });
  const prepareExplicit = Effect.fn("Setup.prepareExplicit")(function* (
    selection: SetupExplicitSelection,
    duplicates: SetupDuplicateAction | undefined,
  ) {
    const chosen = yield* explicitChoices(selection);
    const alternatives = setupVersionAlternatives(observed.changes ?? []);
    const versionChoices: SetupVersionChoice[] = [];
    for (const skillId of selection.useRetainedSkillIds ?? []) {
      const choice = alternatives.find(
        (item) => item.skillId === skillId && item.version === "retained",
      );
      if (!choice) return yield* invalid("Choose an available retained-version alternative");
      versionChoices.push(choice);
    }
    for (const path of selection.useCopyPaths ?? []) {
      const choice = alternatives.find((item) => item.version === "local" && item.path === path);
      if (!choice) return yield* invalid("Choose an available current-copy alternative");
      versionChoices.push(choice);
    }
    return yield* prepareChoices(
      chosen.sourceKeys,
      chosen.values,
      duplicates,
      false,
      selection.reconcileSkillIds ?? [],
      versionChoices,
    );
  });
  const prepareRecommended = (duplicates: SetupDuplicateAction | undefined) =>
    prepareChoices(
      recommended.sources.map((source) => source.groupKey),
      recommendedValues,
      duplicates,
    );
  const recommendedChoices = setupDuplicateActions(yield* selectedCopies(recommendedValues));
  return {
    sources: [...sources.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((source) => ({
        key: source.key,
        id: setupSourceChoiceId(source.key),
        label: source.label,
        skillCount: source.candidates.length,
      })),
    copies: structuredClone(
      copies.map((copy) => ({
        ...copy,
        duplicateActions: setupDuplicateActions([
          {
            name: copy.instance.name,
            sourcePath: copy.instance.path,
            operation: copy.candidate?.action === "bind-existing-entry" ? "bind" : "add",
            conflict: copyConflicts.get(copy.instance.path) ?? { kind: "none" },
          },
        ]),
        ...((removablePaths.get(copy.instance.path)?.length ?? 0) > 0
          ? { removeValue: `remove\0${copy.value}` }
          : {}),
      })),
    ),
    versionAlternatives: setupVersionAlternatives(observed.changes ?? []),
    selectedCopies,
    explicitChoices,
    compareCopies,
    prepareExplicit,
    recommendedChoices,
    recommended: structuredClone(recommended),
    prepare,
    prepareRecommended,
  };
});
export type SetupReview = Effect.Success<ReturnType<typeof openSetupReview>>;
export type SetupReviewSummary = Effect.Success<ReturnType<SetupReview["prepare"]>>["summary"];
